# 🌌 expanded-elm

A wrapper for the [Elm](https://elm-lang.org/) language
[compiler](https://github.com/elm/compiler) that expands it with:

- 🦕 [Deno](https://deno.land/) and [Node.js](https://nodejs.org/) support
- 🏎️ [elm-optimize-level-2](https://github.com/mdgriffith/elm-optimize-level-2)
  optimizations
- 🗜️ [terser](https://terser.org/)
- 🧪 find-and-replace rules for
  [dangerous experiments](https://discourse.elm-lang.org/t/native-code-in-0-19/826)

## Usage

To run this tool, you only need to have Deno and Elm installed on your system.

```bash
deno run -A xelm.ts make [INPUT_FILES] [OPTIONS] --output=[OUTPUT_FILE].js
```

### Build

> **⚠️ Warning**: Binaries built with `deno compile` do not support the
> `--optimize=2` and `--optimize=3` flags.

You can also build a binary by using
[deno compile](https://deno.com/manual@v1.33.4/tools/compiler):

```bash
git clone https://github.com/kress95/expanded-elm.git
cd expanded-elm
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
- `--output=<module-name>.mjs`: Build an ECMAScript module.
  > **Warning**: If you intend to use certain libraries like
  > [elm/http](https://package.elm-lang.org/packages/elm/http/latest/Http), you
  > will need to utilize polyfills like:
  > - [xhr](https://deno.land/x/xhr@0.3.0)
  > - [xhr-shim](https://github.com/apple502j/xhr-shim)
- `--typescript=<runtime>`: Generate TypeScript bindings for the given runtime.
  For example, `--typescript=node` generates bindings for node. Defaults to
  `deno` and requires a `.mjs` output.
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
- `--report=<report-type>`: You can say `--report=json` to get error messages as
  JSON.
- `--docs=<json-file>`: Generate a JSON file with the documentation.
- `--test`: Enable test mode. Can be used with `elm-test-rs` with the
  `--compiler` flag.

### Example

```bash
./xelm Main.elm -o output.js --optimize=2 --minify
```

This example runs `elm` on the `Main.elm` file, optimizes the output with level
2 optimization, and minifies the resulting JavaScript code.

## API

If you prefer a programmatic approach, you can import this tool as a library and
incorporate it into your tooling.

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
| `typescript`      | Generate TypeScript bindings for the given runtime.            |
| `debug`           | Turn on the time-traveling debugger.                           |
| `transformations` | List of find-and-replace transformations to apply.             |
| `optimize`        | Tune the optimization level.                                   |
| `minify`          | Minify the output with terser.                                 |
| `report`          | Change how error messages are reported.                        |
| `docs`            | Generate a JSON file with the documentation.                   |
| `test`            | Enable test mode. Can be used with `elm-test-rs`.              |
| `output`          | Controls how the logs from the compiler should be handled.     |

#### transformations

The `transformations` field of the options object is an array of simple
find-and-replace rules applied to the compiled code.

| Field     | Description      |
| --------- | ---------------- |
| `find`    | Code to find.    |
| `replace` | Code to replace. |

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

### cli(args)

```ts
cli(args: string[] = Deno.args): Promise<Deno.CommandStatus>
```

Executes the command-line interface (CLI).

| Parameter | Description                                   |
| --------- | --------------------------------------------- |
| `args`    | (Optional) An array of command-line arguments |

**Returns:** The status returned from the compiler.

## Transformations

Transformations are simple find-and-replace rules that are applied to the built
code before doing any additional post-processing.

The loader scans the main `README.md` file of the project, as well as the
dependencies of the project, searching for a link to
`#98f5c378-5809-4e35-904e-d1c5c3a8154e`. Afterwards, it matches pairs of
JavaScript code blocks until it comes across an h1, h2, or h3 heading. If a
non-JavaScript code block or an odd number of code blocks is found, an error is
raised.

### Preprocessor

The preprocessor is a small
[DSL](https://en.wikipedia.org/wiki/Domain-specific_language) included to enable
testing and optimization of code transforms. It provides a simple syntax with
two condition constructs and two variables.

#### Variables

The preprocessor supports the following variables:

- `debug`: Represents the debug flag.
- `test`: Represents the test flag.

#### Coditions

The preprocessor offers two condition constructs:

##### @IF

```js
// @IF debug
console.log("This code is included when the debug flag is set");
// @END
```

##### @UNLESS

```js
// @UNLESS test
console.log("This code is included when the test flag is not set");
// @END
```

#### Composition

You can combine multiple condition constructs and variables to create composed
conditional logic. Here's an example:

```js
// @IF debug
//   @IF test
console.log("This code is included when both debug and test flags are set");
//   @END
// @END
```

In the above example, the inner `@IF` construct is only evaluated if the `debug`
flag is set. If both the `debug` and `test` flags are set, the code within the
inner construct will be included.

By leveraging the preprocessor, you can selectively include or exclude code
based on the specified conditions, allowing for efficient testing and
optimization of your transforms.

Please note that the preprocessor has a limited syntax and supports only the
`debug` and `test` variables. It does not provide support for additional custom
variables or complex conditional logic.

### Examples

One example of a library that requires post-processing is
[kress95/elm-html-convert](https://github.com/kress95/elm-html-convert). This
library provides a transform in its `README.md` file. The unit tests included
in the repository also rely on applying this transform.

In the context of an application, my
[elm-ssr-demo](https://github.com/kress95/elm-ssr-demo) application is using
[kress95/elm-html-convert](https://github.com/kress95/elm-html-convert) and,
consequently, requires applying transformations to work. Although in this
particular application `xelm.ts` is used programmatically.

This feature can easily break Elm safety guarantees, so avoid using it unless
you really need it.

## Unlicense (Public Domain)

This is free and unencumbered software released into the public domain.

Anyone is free to copy, modify, publish, use, compile, sell, or distribute this
software, either in source code form or as a compiled binary, for any purpose,
commercial or non-commercial, and by any means.

In jurisdictions that recognize copyright laws, the author or authors of this
software dedicate any and all copyright interest in the software to the public
domain. We make this dedication for the benefit of the public at large and to
the detriment of our heirs and successors. We intend this dedication to be an
overt act of relinquishment in perpetuity of all present and future rights to
this software under copyright law.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

For more information, please refer to &lt;<http://unlicense.org/>&gt;
