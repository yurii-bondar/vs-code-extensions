// Go tokens, mapped to the scopes of VS Code's built-in Go grammar.
// Semantic selectors only take effect when gopls semantic tokens are on ("gopls": { "ui.semanticTokens": true }).

import { tokenItem as item } from './types';
import type { Language } from './types';

const GOPLS_HINT = 'Needs gopls semantic tokens: "gopls": { "ui.semanticTokens": true }.';

export const GO: Language = {
  id: 'go',
  title: 'Go',
  short: 'Go',
  roots: ['source.go'],
  semanticLanguages: ['go'],
  sampleLanguage: 'go',
  groups: [
    {
      title: 'Keywords',
      items: [
        item('kw.package', 'package / import', 'package main, import', ['keyword.package', 'keyword.import']),
        item('kw.control', 'Control flow', 'if, for, range, switch, return, go, defer, select', ['keyword.control']),
        item('kw.func', 'func', 'func', ['keyword.function']),
        item('kw.type', 'Type keywords', 'type, struct, interface', ['keyword.type', 'keyword.struct', 'keyword.interface']),
        item('kw.decl', 'var / const', 'var, const', ['keyword.var', 'keyword.const']),
        item('kw.map', 'map / chan', 'map[string]int, chan error', ['keyword.map', 'keyword.channel']),
      ],
    },
    {
      title: 'Types',
      items: [
        item('type.builtin', 'Built-in types', 'string, int, error, byte, rune, bool, any', ['storage.type', 'entity.name.type.any', 'entity.name.type.comparable'], ['type.defaultLibrary']),
        item('type.name', 'Type names', 'type Server struct, *http.Request', ['entity.name.type'], ['type', 'interface', 'struct']),
        item('type.param', 'Generic type parameters', '[T any]', [], ['typeParameter'], GOPLS_HINT),
        item('type.package', 'Package names', 'fmt.Printf, http.Request, package main', ['entity.name.type.package', 'entity.name.package', 'entity.alias.import'], ['namespace']),
      ],
    },
    {
      title: 'Functions & names',
      items: [
        item('fn.decl', 'Function declarations', 'func Start(), func (s *Server) Serve()', ['entity.name.function'], ['function.definition', 'method.definition']),
        item('fn.call', 'Function calls', 'fmt.Printf(), s.Start()', ['support.function'], ['function', 'method']),
        item('fn.builtin', 'Built-in functions', 'len, make, append, close, panic', ['entity.name.function.support.builtin', 'support.function.builtin'], ['function.defaultLibrary']),
        item('id.var', 'Variables', 'ch := …, var ratio', ['variable.other', 'variable.other.assignment', 'variable.other.declaration'], ['variable']),
        item('id.const', 'Constants', 'const MaxRetries', ['variable.other.constant'], ['variable.readonly']),
        item('id.param', 'Parameters & receivers', 'func (s *Server) f(ctx context.Context)', ['variable.parameter'], ['parameter']),
        item('id.field', 'Struct fields', 'Name string, s.Name', ['variable.other.property', 'variable.other.field', 'variable.other.struct'], ['property', 'variable.field']),
      ],
    },
    {
      title: 'Literals',
      items: [
        item('lit.string', 'Strings', '"hello"', ['string.quoted.double', 'punctuation.definition.string']),
        item('lit.raw', 'Raw strings & struct tags', '`json:"name"`', ['string.quoted.raw']),
        item('lit.rune', 'Runes', "'a', '\\t'", ['string.quoted.rune', 'constant.other.rune']),
        item('lit.import', 'Import paths', '"net/http"', ['entity.name.import']),
        item('lit.verb', 'Format verbs', '%d, %s, %v, %w', ['constant.other.placeholder']),
        item('lit.escape', 'Escape sequences', '\\n, \\t', ['constant.character.escape']),
        item('lit.number', 'Numbers', '42, 0.75, 0xff, 1e6', ['constant.numeric']),
        item('lit.const', 'true / false / nil / iota', 'nil, true, iota', ['constant.language']),
      ],
    },
    {
      title: 'Operators & punctuation',
      items: [
        item('op.general', 'Operators', '+ - * / == != && ...', ['keyword.operator']),
        item('op.assign', 'Assignment', ':= = +=', ['keyword.operator.assignment']),
        item('op.address', 'Pointers', '&value, *Server', ['keyword.operator.address']),
        item('op.channel', 'Channel arrow', 'ch <- v, <-ch', ['keyword.operator.channel']),
        item('punc.brace', 'Brackets', '( ) [ ] { }', ['punctuation.definition.begin.bracket', 'punctuation.definition.end.bracket', 'punctuation.definition.bracket'], [], 'Bracket pair colorization (Appearance → Editor) overrides this.'),
        item('punc.sep', 'Separators', ', ; : .', ['punctuation.other', 'punctuation.terminator', 'punctuation.separator']),
      ],
    },
    {
      title: 'Comments',
      items: [item('cmt', 'Comments', '// note, /* block */', ['comment', 'punctuation.definition.comment'])],
    },
  ],
  sample: [
    '⟦kw.package¦package⟧ ⟦type.package¦main⟧',
    '',
    '⟦kw.package¦import⟧ ⟦punc.brace¦(⟧',
    '\t⟦lit.import¦"context"⟧',
    '\t⟦lit.import¦"fmt"⟧',
    '\t⟦lit.import¦"net/http"⟧',
    '⟦punc.brace¦)⟧',
    '',
    '⟦cmt¦// Server handles incoming requests.⟧',
    '⟦kw.type¦type⟧ ⟦type.name¦Server⟧ ⟦kw.type¦struct⟧ ⟦punc.brace¦{⟧',
    '\t⟦id.field¦Name⟧  ⟦type.builtin¦string⟧ ⟦lit.raw¦`json:"name"`⟧',
    '\t⟦id.field¦port⟧  ⟦type.builtin¦int⟧',
    '\t⟦id.field¦cache⟧ ⟦kw.map¦map⟧⟦punc.brace¦[⟧⟦type.builtin¦string⟧⟦punc.brace¦][]⟧⟦type.builtin¦byte⟧',
    '⟦punc.brace¦}⟧',
    '',
    '⟦kw.type¦type⟧ ⟦type.name¦Handler⟧ ⟦kw.type¦interface⟧ ⟦punc.brace¦{⟧',
    '\t⟦fn.decl¦Serve⟧⟦punc.brace¦(⟧⟦id.param¦w⟧ ⟦type.package¦http⟧⟦punc.sep¦.⟧⟦type.name¦ResponseWriter⟧⟦punc.sep¦,⟧ ⟦id.param¦r⟧ ⟦op.address¦*⟧⟦type.package¦http⟧⟦punc.sep¦.⟧⟦type.name¦Request⟧⟦punc.brace¦)⟧ ⟦type.builtin¦error⟧',
    '⟦punc.brace¦}⟧',
    '',
    '⟦kw.decl¦const⟧ ⟦id.const¦MaxRetries⟧ ⟦op.assign¦=⟧ ⟦lit.number¦3⟧',
    '⟦kw.decl¦const⟧ ⟦id.const¦sep⟧ ⟦op.assign¦=⟧ ⟦lit.rune¦\'\\t\'⟧',
    '⟦kw.decl¦var⟧ ⟦id.var¦ratio⟧ ⟦type.builtin¦float64⟧ ⟦op.assign¦=⟧ ⟦lit.number¦0.75⟧',
    '',
    '⟦kw.func¦func⟧ ⟦fn.decl¦Keys⟧⟦punc.brace¦[⟧⟦type.param¦K⟧ ⟦type.builtin¦comparable⟧⟦punc.sep¦,⟧ ⟦type.param¦V⟧ ⟦type.builtin¦any⟧⟦punc.brace¦](⟧⟦id.param¦m⟧ ⟦kw.map¦map⟧⟦punc.brace¦[⟧⟦type.param¦K⟧⟦punc.brace¦]⟧⟦type.param¦V⟧⟦punc.brace¦)⟧ ⟦punc.brace¦[]⟧⟦type.param¦K⟧ ⟦punc.brace¦{⟧ ⟦kw.control¦return⟧ ⟦lit.const¦nil⟧ ⟦punc.brace¦}⟧',
    '',
    '⟦kw.func¦func⟧ ⟦punc.brace¦(⟧⟦id.param¦s⟧ ⟦op.address¦*⟧⟦type.name¦Server⟧⟦punc.brace¦)⟧ ⟦fn.decl¦Start⟧⟦punc.brace¦(⟧⟦id.param¦ctx⟧ ⟦type.package¦context⟧⟦punc.sep¦.⟧⟦type.name¦Context⟧⟦punc.sep¦,⟧ ⟦id.param¦addrs⟧ ⟦op.general¦...⟧⟦type.builtin¦string⟧⟦punc.brace¦)⟧ ⟦type.builtin¦error⟧ ⟦punc.brace¦{⟧',
    '\t⟦id.var¦ch⟧ ⟦op.assign¦:=⟧ ⟦fn.builtin¦make⟧⟦punc.brace¦(⟧⟦kw.map¦chan⟧ ⟦type.builtin¦error⟧⟦punc.sep¦,⟧ ⟦fn.builtin¦len⟧⟦punc.brace¦(⟧⟦id.param¦addrs⟧⟦punc.brace¦))⟧',
    '\t⟦kw.control¦for⟧ ⟦id.var¦i⟧⟦punc.sep¦,⟧ ⟦id.var¦addr⟧ ⟦op.assign¦:=⟧ ⟦kw.control¦range⟧ ⟦id.param¦addrs⟧ ⟦punc.brace¦{⟧',
    '\t\t⟦kw.control¦go⟧ ⟦kw.func¦func⟧⟦punc.brace¦()⟧ ⟦punc.brace¦{⟧ ⟦id.var¦ch⟧ ⟦op.channel¦<-⟧ ⟦type.package¦http⟧⟦punc.sep¦.⟧⟦fn.call¦ListenAndServe⟧⟦punc.brace¦(⟧⟦id.var¦addr⟧⟦punc.sep¦,⟧ ⟦lit.const¦nil⟧⟦punc.brace¦)⟧ ⟦punc.brace¦}()⟧',
    '\t\t⟦type.package¦fmt⟧⟦punc.sep¦.⟧⟦fn.call¦Printf⟧⟦punc.brace¦(⟧⟦lit.string¦"listening #⟧⟦lit.verb¦%d⟧⟦lit.string¦ on ⟧⟦lit.verb¦%s⟧⟦lit.escape¦\\n⟧⟦lit.string¦"⟧⟦punc.sep¦,⟧ ⟦id.var¦i⟧⟦punc.sep¦,⟧ ⟦id.var¦addr⟧⟦punc.brace¦)⟧',
    '\t⟦punc.brace¦}⟧',
    '\t⟦kw.control¦defer⟧ ⟦fn.builtin¦close⟧⟦punc.brace¦(⟧⟦id.var¦ch⟧⟦punc.brace¦)⟧',
    '\t⟦kw.control¦if⟧ ⟦id.var¦err⟧ ⟦op.assign¦:=⟧ ⟦op.channel¦<-⟧⟦id.var¦ch⟧⟦punc.sep¦;⟧ ⟦id.var¦err⟧ ⟦op.general¦!=⟧ ⟦lit.const¦nil⟧ ⟦punc.brace¦{⟧',
    '\t\t⟦kw.control¦return⟧ ⟦type.package¦fmt⟧⟦punc.sep¦.⟧⟦fn.call¦Errorf⟧⟦punc.brace¦(⟧⟦lit.string¦"start ⟧⟦lit.verb¦%q⟧⟦lit.string¦: ⟧⟦lit.verb¦%w⟧⟦lit.string¦"⟧⟦punc.sep¦,⟧ ⟦id.param¦s⟧⟦punc.sep¦.⟧⟦id.field¦Name⟧⟦punc.sep¦,⟧ ⟦id.var¦err⟧⟦punc.brace¦)⟧',
    '\t⟦punc.brace¦}⟧',
    '\t⟦kw.control¦switch⟧ ⟦punc.brace¦{⟧ ⟦kw.control¦case⟧ ⟦id.var¦ratio⟧ ⟦op.general¦>⟧ ⟦lit.number¦1⟧⟦punc.sep¦:⟧ ⟦fn.builtin¦panic⟧⟦punc.brace¦(⟧⟦lit.raw¦`bad ratio`⟧⟦punc.brace¦)⟧ ⟦punc.brace¦}⟧',
    '\t⟦kw.control¦return⟧ ⟦lit.const¦nil⟧',
    '⟦punc.brace¦}⟧',
  ],
};
