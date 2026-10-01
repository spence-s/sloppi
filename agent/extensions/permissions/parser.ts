import {basename} from 'node:path';
import {
  parse,
  type ArithmeticExpression,
  type Assignment,
  type Command,
  type ParsedScript,
  type PipelineNode,
  type Redirection,
  type Statement,
  type TestExpression,
  type Word,
  type WordPart,
  type AndOr,
  type CompoundList,
} from 'unbash';
import type {PermissionRule} from './config.ts';

export const permissionParseLimit = 64 * 1024;

export type PermissionInvocation = {
  argv: string[];
  end: number;
  pos: number;
  selectors: string[];
};

/**
Accepts only words whose dequoted value requires no shell expansion.
*/
function isLiteralWord(word: Word): boolean {
  /**
  Recursively permits quoting while rejecting every expansion node.
  */
  const isLiteralPart = (part: WordPart): boolean => {
    if (['Literal', 'SingleQuoted', 'AnsiCQuoted'].includes(part.type)) {
      return true;
    }

    return part.type === 'DoubleQuoted' || part.type === 'LocaleString' ? part.parts.every(child => isLiteralPart(child)) : false;
  };

  return (word.parts ?? []).every(part => isLiteralPart(part));
}

/**
Finds confidently literal configured invocations without evaluating shell behavior.
*/
export function findPermissionInvocations(source: string, rules: PermissionRule[]): PermissionInvocation[] {
  const hasDisallowedControl = [...source].some(character => {
    const code = character.codePointAt(0) ?? 0;
    return (code < 32 && code !== 9) || code === 127;
  });
  if (hasDisallowedControl || source.length > permissionParseLimit) {
    return [];
  }

  const configuredRules = rules.map(rule => ({
    ...rule,
    commandWords: rule.command.split(/\s+/v),
    passthroughWords: (rule.passthrough ?? []).map(sequence => sequence.split(/\s+/v)),
  }));
  const matches: PermissionInvocation[] = [];
  let hasParseError = false;

  /**
  Visits one expansion-capable word part without relying on enumerable properties.
  */
  function visitPart(part: WordPart): void {
    switch (part.type) {
      case 'CommandExpansion':
      case 'ProcessSubstitution': {
        if (part.script !== undefined) {
          visitScript(part.script);
        }

        return;
      }

      case 'DoubleQuoted':
      case 'LocaleString':
      case 'ExtendedGlob':
      case 'BraceExpansion': {
        visitParts(part.parts);
        return;
      }

      case 'ParameterExpansion': {
        if (part.index !== undefined) {
          visitWord(part.index);
        }

        switch (part.operation?.type) {
          case 'Default':
          case 'Remove':
          case 'Transform': {
            visitWord(part.operation.operand);
            break;
          }

          case 'CaseModification': {
            if (part.operation.operand !== undefined) {
              visitWord(part.operation.operand);
            }

            break;
          }

          case 'Replace': {
            visitWord(part.operation.pattern);
            visitWord(part.operation.replacement);
            break;
          }

          case 'Slice': {
            visitWord(part.operation.offset);
            if (part.operation.length !== undefined) {
              visitWord(part.operation.length);
            }

            break;
          }

          case 'Names':
          case 'Unknown':
          case undefined: {
            break;
          }
        }

        return;
      }

      case 'ArithmeticExpansion': {
        if (part.expression !== undefined) {
          visitArithmetic(part.expression);
        }

        break;
      }

      case 'Literal':
      case 'SingleQuoted':
      case 'AnsiCQuoted':
      case 'SimpleExpansion': {
        break;
      }
    }
  }

  /**
  Visits nested shell carried by every expansion-capable word part.
  */
  function visitParts(parts: readonly WordPart[] | undefined): void {
    for (const part of parts ?? []) {
      visitPart(part);
    }
  }

  /**
  Forces unbash's lazy word parts so nested scripts cannot evade inspection.
  */
  function visitWord(word: Word): void {
    visitParts(word.parts);
  }

  /**
  Visits command substitutions embedded in arithmetic expressions.
  */
  function visitArithmetic(expression: ArithmeticExpression): void {
    switch (expression.type) {
      case 'ArithmeticBinary': {
        visitArithmetic(expression.left);
        visitArithmetic(expression.right);

        break;
      }

      case 'ArithmeticUnary': {
        visitArithmetic(expression.operand);

        break;
      }

      case 'ArithmeticTernary': {
        visitArithmetic(expression.test);
        visitArithmetic(expression.consequent);
        visitArithmetic(expression.alternate);

        break;
      }

      case 'ArithmeticGroup': {
        visitArithmetic(expression.expression);

        break;
      }

      case 'ArithmeticWord': {
        visitParts(expression.parts);

        break;
      }

      case 'ArithmeticCommandExpansion': {
        if (expression.script !== undefined) {
          visitScript(expression.script);
        }

        break;
      }
    }
  }

  /**
  Visits words embedded in [[ ]] expressions.
  */
  function visitTest(expression: TestExpression): void {
    switch (expression.type) {
      case 'TestUnary': {
        visitWord(expression.operand);

        break;
      }

      case 'TestBinary': {
        visitWord(expression.left);
        visitWord(expression.right);

        break;
      }

      case 'TestLogical': {
        visitTest(expression.left);
        visitTest(expression.right);

        break;
      }

      case 'TestNot': {
        visitTest(expression.operand);

        break;
      }

      case 'TestGroup': {
        visitTest(expression.expression);
        break;
      }
    }
  }

  /**
  Visits redirect targets and heredoc bodies because either can contain process
  substitutions or command expansions that execute independently of argv.
  */
  function visitRedirect(redirect: Redirection): void {
    if (redirect.type === 'HereDoc') {
      visitParts(redirect.body.parts);
      return;
    }

    if (redirect.target !== undefined) {
      visitWord(redirect.target);
    }
  }

  /**
  Visits assignment indexes and values wherever unbash permits assignments in a
  command, including array elements whose words can contain nested scripts.
  */
  function visitAssignment(assignment: Assignment): void {
    if (assignment.index !== undefined) {
      visitWord(assignment.index);
    }

    if (assignment.value.type === 'Word') {
      visitWord(assignment.value);
      return;
    }

    for (const element of assignment.value.elements) {
      visitWord(element);
    }
  }

  /**
  Classifies one simple command and records selectors matching its literal argv prefix.
  */
  function visitCommand(command: Command): void {
    if (command.name !== undefined) {
      const argv = [command.name.value, ...command.args.map(argument => argument.type === 'Word' ? argument.value : argument.text)];
      const literal = [isLiteralWord(command.name), ...command.args.map(argument => argument.type === 'Word' && isLiteralWord(argument))];
      const commandName = basename(argv[0] ?? '');
      const matched = configuredRules
        .filter(rule => rule.commandWords.length <= argv.length
          && rule.commandWords.every((word, index) => literal[index] === true
            && (index === 0 ? commandName : argv[index]) === word))
        .filter(rule => {
          const separator = argv.findIndex((argument, index) => index >= rule.commandWords.length
            && literal[index] === true
            && argument === '--');
          const searchEnd = separator === -1 ? argv.length : separator;
          return !rule.passthroughWords.some(sequence => {
            for (let index = rule.commandWords.length; index + sequence.length <= searchEnd; index++) {
              if (sequence.every((word, offset) => literal[index + offset] === true && argv[index + offset] === word)) {
                return true;
              }
            }

            return false;
          });
        })
        .map(rule => rule.command);

      if (matched.length > 0) {
        matches.push({
          argv: [commandName, ...argv.slice(1)], end: command.end, pos: command.pos, selectors: matched,
        });
      }
    }

    if (command.name !== undefined) {
      visitWord(command.name);
    }

    for (const item of [...command.prefix, ...command.suffix]) {
      if (item.type === 'Word') {
        visitWord(item);
      } else if (item.type === 'Assignment') {
        visitAssignment(item);
      } else {
        visitRedirect(item);
      }
    }
  }

  /**
  Traverses every executable AST position supported by unbash.
  */
  // Keeping exhaustive AST dispatch together makes security review simpler.
  function visitNode(node: Statement | CompoundList | PipelineNode | AndOr): void {
    switch (node.type) {
      case 'Command': {
        visitCommand(node);
        break;
      }

      case 'Pipeline':
      case 'AndOr': {
        for (const command of node.commands) {
          visitNode(command);
        }

        break;
      }

      case 'Time':
      case 'Negation': {
        if (node.command !== undefined) {
          visitNode(node.command);
        }

        break;
      }

      case 'Redirected': {
        visitNode(node.command);
        for (const redirect of node.redirects) {
          visitRedirect(redirect);
        }

        break;
      }

      case 'If': {
        visitNode(node.clause);
        visitNode(node.then);
        if (node.else !== undefined) {
          visitNode(node.else);
        }

        break;
      }

      case 'For':
      case 'Select': {
        visitWord(node.name);
        for (const word of node.wordlist ?? []) {
          visitWord(word);
        }

        visitNode(node.body);
        break;
      }

      case 'ArithmeticFor': {
        if (node.initialize !== undefined) {
          visitArithmetic(node.initialize);
        }

        if (node.test !== undefined) {
          visitArithmetic(node.test);
        }

        if (node.update !== undefined) {
          visitArithmetic(node.update);
        }

        visitNode(node.body);
        break;
      }

      case 'While': {
        visitNode(node.clause);
        visitNode(node.body);
        break;
      }

      case 'Function':
      case 'Coproc': {
        if (node.name !== undefined) {
          visitWord(node.name);
        }

        visitNode(node.body);
        break;
      }

      case 'Subshell':
      case 'BraceGroup': {
        visitNode(node.body);
        break;
      }

      case 'CompoundList': {
        for (const statement of node.commands) {
          visitNode(statement);
        }

        break;
      }

      case 'Case': {
        visitWord(node.word);
        for (const item of node.items) {
          for (const pattern of item.pattern) {
            visitWord(pattern);
          }

          visitNode(item.body);
        }

        break;
      }

      case 'TestCommand': {
        visitTest(node.expression);
        break;
      }

      case 'ArithmeticCommand': {
        if (node.expression !== undefined) {
          visitArithmetic(node.expression);
        }

        break;
      }

      case 'Statement': {
        visitNode(node.command);
        break;
      }
    }
  }

  /**
  Checks each root or nested script before trusting any collected match.
  */
  function visitScript(script: ParsedScript): void {
    hasParseError ||= (script.errors?.length ?? 0) > 0;
    for (const statement of script.commands) {
      visitNode(statement);
    }
  }

  visitScript(parse(source));
  return hasParseError ? [] : matches;
}
