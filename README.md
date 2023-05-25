# 🌌 extended-elm

A wrapper for the [Elm](https://elm-lang.org/) language
[compiler](https://github.com/elm/compiler) that extends it with:
- 🦕 [Deno](https://deno.land/) support
- 🏎️ [elm-optimize-level-2](https://github.com/mdgriffith/elm-optimize-level-2) 
optimizations
- 🗜️ [terser](https://terser.org/)
- 🧪 find-and-replace rules for
[dangerous experiments](https://discourseg.elm-lang.org/t/native-code-in-0-19/826)

## Usage

To run this tool, you only need to have Deno and Elm installed on your system.

```bash
deno run -A xelm.ts make [INPUT_FILES] [OPTIONS] --output=[OUTPUT_FILE].js
```

### Build

> **Warning**: This is currently not possible due to an issue with
> [elm-optimize-level-2](https://github.com/mdgriffith/elm-optimize-level-2)

You can also build a binary by using
[deno compile](https://deno.com/manual@v1.33.4/tools/compiler):

```bash
git clone https://github.com/kress95/extended-elm.git
cd extended-elm
deno compile --output xelm -A xelm.ts
```

## CLI

```bash
./xelm make [INPUT_FILES] [OPTIONS] --output=[OUTPUT_FILE].js
```

Replace `[INPUT_FILES]`, `[OPTIONS]`, and `[OUTPUT_FILE]` with the appropriate
values.

In addition, you can also run the other commands from Elm, such as `repl`,
`init`, `reactor`, `install`, `bump`, `diff`, and `publish`, directly within
`xelm`. These commands are simply forwarded, so there's no reason not to invoke
them directly through `elm`.

### Options

The options available for `xelm make` include:

- `--project=<project-root>`: Path to the root directory of the project.
  Defaults to the current working directory.
- `--compiler=<elm-binary>`: The path to the Elm binary, which is `elm` by
  default.
- `--elm-home=<elm-home>`: Use a custom directory for `ELM_HOME`, which is
  `~/.elm` by default.
- `--deno`: Enable a patch for running Elm in Deno.
  > **Warning**: The generated code still pollutes `globalThis.Elm`, and if
  > you intend to use certain libraries like
  > [elm/http](https://package.elm-lang.org/packages/elm/http/latest/Http),
  > you will need to utilize
  > [polyfills](https://github.com/apple502j/xhr-shim).
- `--debug`: Turn on the time-travelling debugger.
- `--transform`: Enable loading find-and-replace transformations from
  `README.md` files.
- `--optimize=`: Tune the optimization level.
  - `0` Disable all optimizations, same as omitting the flag.
  - `1` Same as running `elm make --optimize`.
  - `2` Same as running `elm-optimize-level-2`.
  - `3` Same as running `elm-optimize-level-2 --optimize-speed`.
- `--minify`: Minify the output with terser, loading configuration from
  `terser.config.json` if available.
- `--report=<report-type>`: You can say `--report=json` to get error messages
  as JSON. 
- `--docs=<json-file>`: Generate a JSON file with the documentation.
- `--test`: Load transformations from test dependencies.

### Example

```bash
./xelm Main.elm -o output.js --optimize=2 --minify
```

This example runs `elm` on the `Main.elm` file, optimizes the output with
level 2 optimization, and minifies the resulting JavaScript code.

## API

If you prefer a programmatic approach, you can import this tool as a library
and incorporate it into your tooling.

### elm(inputs, output, options)

```ts
elm(inputs: string[], output: string, options?: Options): Promise<Deno.CommandStatus>
```

Compiles the input files and performs additional postprocessing.

| Parameter | Description                                |
| --------- | ------------------------------------------ |
| `inputs`  | The input files to read.                   |
| `output`  | The name of the resulting JavaScript file. |
| `options` | (Optional) The compiler options.           |

**Returns:** The status returned from the compiler.

#### options

The `options` field provides various compiler options for the API.

| Field             | Description                                                    |
| ----------------- | -------------------------------------------------------------- |
| `projectRoot`     | Path to the root directory of the project.                     |
| `elmPath`         | The path to the Elm binary.                                    |
| `elmHome`         | Custom directory for `ELM_HOME`, which is `~/.elm` by default. |
| `deno`            | Enable a patch for running Elm in Deno.                        |
| `debug`           | Turn on the time-traveling debugger.                           |
| `transformations` | List of find-and-replace transformations to apply.             |
| `optimize`        | Tune the optimization level.                                   |
| `minify`          | Minify the output with terser.                                 |
| `report`          | Change how error messages are reported.                        |
| `docs`            | Generate a JSON file with the documentation.                   |
| `test`            | Load transformations from test dependencies.                   |

#### transformations

The `transformations` field of the options object is an array of simple
find-and-replace rules applied to the compiled code.

| Field    | Description      |
| -------- | ---------------- |
| `find`   | Code to find.    |
| `replace`| Code to replace. |

### xelm(inputs, output, options)

```ts
xelm(inputs: string[], output: string, options?: ExtraOptions): Promise<Deno.CommandStatus>
```

Retrieve transformations from the project and dependency `README.md` files
before compiling.

| Parameter | Description                                                |
| --------- | ---------------------------------------------------------- |
| `inputs`  | The input files to read.                                   |
| `output`  | The name of the resulting JavaScript file.                 |
| `options` | (Optional) The compiler options, including `ExtraOptions`. |

**Returns:** The status returned from the compiler.

#### options

Provide the same options as before, along with:

| Field     | Description                                |
| --------- | ------------------------------------------ |
| `refresh` | Force refreshing the transformation cache. |

## Transformations

Transformations are simple find-and-replace rules that are applied to the built
code before doing any additional post-processing.

The loader parses through the `README.md` files looking for a link to 
`#98f5c378-5809-4e35-904e-d1c5c3a8154e`.

Then it starts matching pairs of JavaScript code blocks until it comes across
an h1, h2, or h3 heading. An error is raised if an uneven amount of code-blocks
is found.

### Example

This library requires [post-processing](#98f5c378-5809-4e35-904e-d1c5c3a8154e):

#### where:

```js
var $author$project$Server$Html$toJson = function (_v0) {
  return $elm$json$Json$Encode$string('a7e4173c7ea41051bf56e286966e5acc195472204f0cf016ebbd94dde5f18ec7');
};
```

#### replace with:

```js
var virtualDomKernelConstants = {
  nodeTypeTagger: 4,
  nodeTypeThunk: 5,
  kids: "e",
  refs: "l",
  thunk: "m",
  node: "k",
  value: "a",
};

function forceThunks(vNode) {
  if (typeof vNode !== "undefined" && vNode.$ === "#2") {
    vNode.b = forceThunks(vNode.b);
  }
  if (
    typeof vNode !== "undefined" &&
    vNode.$ === virtualDomKernelConstants.nodeTypeThunk &&
    !vNode[virtualDomKernelConstants.node]
  ) {
    var args = vNode[virtualDomKernelConstants.thunk];
    vNode[virtualDomKernelConstants.node] =
      vNode[virtualDomKernelConstants.thunk].apply(args);
    vNode[virtualDomKernelConstants.node] = forceThunks(
      vNode[virtualDomKernelConstants.node],
    );
  }
  if (
    typeof vNode !== "undefined" &&
    vNode.$ === virtualDomKernelConstants.nodeTypeTagger
  ) {
    vNode[virtualDomKernelConstants.node] = forceThunks(
      vNode[virtualDomKernelConstants.node],
    );
  }
  if (
    typeof vNode !== "undefined" &&
    typeof vNode[virtualDomKernelConstants.kids] !== "undefined"
  ) {
    vNode[virtualDomKernelConstants.kids] =
      vNode[virtualDomKernelConstants.kids].map(forceThunks);
  }
  return vNode;
}

function _HtmlAsJson_toJson(html) {
  return _Json_wrap(forceThunks(html));
}

function _HtmlAsJson_eventHandler(event) {
  return event[virtualDomKernelConstants.value];
}

function _HtmlAsJson_taggerFunction(tagger) {
  return tagger.a;
}

function _HtmlAsJson_attributeToJson(attribute) {
  return _Json_wrap(attribute);
}

var $author$project$Server$Html$toJson = _HtmlAsJson_toJson;
```

This feature can easily break Elm safety guarantees, so avoid using it unless
you really need it.

## Unlicense (Public Domain)

This is free and unencumbered software released into the public domain.

Anyone is free to copy, modify, publish, use, compile, sell, or
distribute this software, either in source code form or as a compiled
binary, for any purpose, commercial or non-commercial, and by any
means.

In jurisdictions that recognize copyright laws, the author or authors
of this software dedicate any and all copyright interest in the
software to the public domain. We make this dedication for the benefit
of the public at large and to the detriment of our heirs and
successors. We intend this dedication to be an overt act of
relinquishment in perpetuity of all present and future rights to this
software under copyright law.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR
OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.

For more information, please refer to &lt;<http://unlicense.org/>&gt;
