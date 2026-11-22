# CodeMirror 5.65.18

Editor de la vista "Código" de FRAP. MIT (ver `LICENSE`), https://codemirror.net/5/ — paquete npm `codemirror@5.65.18`.

`codemirror.js` y `codemirror.css` son la concatenación (sin cambios) de estos archivos del paquete, en este orden:
es un script clásico (UMD), así que funciona abriendo `index.html` como `file://`.

- **Núcleo**: `lib/codemirror.js`, `mode/meta.js` (modo por extensión), `addon/mode/{overlay,simple,multiplex}.js`
- **Lenguajes** (`mode/*`): javascript (JS/TS/JSON), css (CSS/SCSS/Less), xml, htmlmixed, markdown, gfm, clike (C/C++/Java/C#/Kotlin…),
  php, python, shell, sql, yaml, go, rust, ruby, dockerfile, toml, properties, diff, jsx, nginx, lua, sass, perl, swift, cmake,
  vue, pug, handlebars, coffeescript, stylus, powershell, r, protobuf, haskell, clojure, erlang, julia, groovy, twig, jinja2,
  htmlembedded, http, vb, dart, elm, crystal, yaml-frontmatter, rst, stex
- **Addons**: edit/{matchbrackets,closebrackets,matchtags,closetag,trailingspace}, comment/comment,
  fold/{foldcode,foldgutter,brace-fold,indent-fold,xml-fold,markdown-fold,comment-fold}, selection/active-line,
  search/{searchcursor,search,jump-to-line,matchesonscrollbar,match-highlighter}, dialog/dialog,
  scroll/{annotatescrollbar,scrollpastend}, hint/{show-hint,anyword-hint}, keymap/sublime (Ctrl+D, multicursor, mover líneas…)
- **CSS**: lib/codemirror.css, addon/dialog/dialog.css, addon/fold/foldgutter.css, addon/search/matchesonscrollbar.css, addon/hint/show-hint.css

El tema (`cm-s-frap`) está en `src/index.css`, con las variables de FRAP.
