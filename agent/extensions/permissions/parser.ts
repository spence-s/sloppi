import {basename} from 'node:path';
import {
  parse,
  type ArithmeticExpression,
  type Command,
  type Node,
  type ParsedScript,
  type Redirect,
  type TestExpression,
  type Word,
  type WordPart,
} from 'unbash';
import type {PermissionRule} from './config.ts';

export const permissionParseLimit = 64 * 1024;

export type PermissionInvocation = {
  argv: string[];
  end: number;
  pos: number;
  selectors: string[];
};

/** Accepts only words whose dequoted value requires no shell expansion. */
function isLiteralWord(word: Word): boolean {
  /** Recursively permits quoting while rejecting every expansion node. */
  const isLiteralPart = (part: WordPart): boolean => {
    if (['Literal', 'SingleQuoted', 'AnsiCQuoted'].includes(part.type)) {
      return true;
    }

    if (part.type === 'DoubleQuoted' || part.type === 'LocaleString') {
      return part.parts.every(child => isLiteralPart(child));
    }

    return false;
  };

  return (word.parts ?? []).every(part => isLiteralPart(part));
}

/** Finds confidently literal configured invocations without evaluating shell behavior. */
export function findPermissionInvocations(source: string, rules: PermissionRule[]): PermissionInvocation[] {
  const hasDisallowedControl = [...source].some(character => {
    const code = character.codePointAt(0) ?? 0;
    return (code < 32 && code !== 9) || code === 127;
  });
  if (source.length > permissionParseLimit || hasDisallowedControl) {
    return [];
  }

  const configuredRules = rules.map(rule => ({
    ...rule,
    commandWords: rule.command.split(/\s+/v),
    passthroughWords: (rule.passthrough ?? []).map(sequence => sequence.split(/\s+/v)),
  }));
  const matches: PermissionInvocation[] = [];
  let hasParseError = false;

  /** Visits one expansion-capable word part without relying on enumerable properties. */
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
        visitParts(part.indexParts);
        if (part.operand !== undefined) {
          visitWord(part.operand);
        }

        if (part.slice !== undefined) {
          visitWord(part.slice.offset);
          if (part.slice.length !== undefined) {
            visitWord(part.slice.length);
          }
        }

        if (part.replace !== undefined) {
          visitWord(part.replace.pattern);
          visitWord(part.replace.replacement);
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

  /** Visits nested shell carried by every expansion-capable word part. */
  function visitParts(parts: WordPart[] | undefined): void {
    for (const part of parts ?? []) {
      visitPart(part);
    }
  }

  /** Forces unbash's lazy word parts so nested scripts cannot evade inspection. */
  function visitWord(word: Word): void {
    visitParts(word.parts);
  }

  /** Visits command substitutions embedded in arithmetic expressions. */
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

  /** Visits words embedded in [[ ]] expressions. */
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

  /** Visits redirect words because process substitutions may execute there. */
  function visitRedirect(redirect: Redirect): void {
    if (redirect.target !== undefined) {
      visitWord(redirect.target);
    }

    if (redirect.body !== undefined) {
      visitWord(redirect.body);
    }
  }

  /** Classifies one simple command and records selectors matching its literal argv prefix. */
  function visitCommand(command: Command): void {
    if (command.name !== undefined) {
      const words = [command.name, ...command.suffix];
      const argv = words.map(word => word.value);
      const literal = words.map(word => isLiteralWord(word));
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

    for (const prefix of command.prefix) {
      if (prefix.value !== undefined) {
        visitWord(prefix.value);
      }

      for (const word of prefix.array ?? []) {
        visitWord(word);
      }

      visitParts(prefix.indexParts);
    }

    for (const word of command.suffix) {
      visitWord(word);
    }

    for (const redirect of command.redirects) {
      visitRedirect(redirect);
    }
  }

  /** Traverses every executable AST position supported by unbash. */
  // eslint-disable-next-line complexity -- Keeping exhaustive AST dispatch together makes security review simpler.
  function visitNode(node: Node): void {
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
        for (const word of node.wordlist) {
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
        for (const redirect of node.redirects) {
          visitRedirect(redirect);
        }

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
        for (const redirect of node.redirects) {
          visitRedirect(redirect);
        }

        break;
      }
    }
  }

  /** Checks each root or nested script before trusting any collected match. */
  function visitScript(script: ParsedScript): void {
    hasParseError ||= (script.errors?.length ?? 0) > 0;
    for (const statement of script.commands) {
      visitNode(statement);
    }
  }

  visitScript(parse(source));
  return hasParseError ? [] : matches;
}
