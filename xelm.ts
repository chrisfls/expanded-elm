#!/usr/bin/env -S deno run -A
import { cyan as colorize } from "https://deno.land/std@0.190.0/fmt/colors.ts";
import { parse } from "https://deno.land/std@0.190.0/flags/mod.ts";
import * as fs from "https://deno.land/std@0.190.0/fs/mod.ts";
import * as path from "https://deno.land/std@0.190.0/path/mod.ts";
import { marked } from "https://esm.sh/marked@5.0.4/";
import { minify, MinifyOptions } from "https://esm.sh/terser@5.17.6";
import "npm:typescript@4.7.4";
import { transform as optimize } from "npm:elm-optimize-level-2@0.3.5";

/** Compiler options. */
export interface Options {
  /** Path to the root directory of the project. */
  projectRoot?: string;
  /** The path to the Elm binary. */
  elmPath?: string;
  /** Custom directory for ELM_HOME, which is `~/.elm` by default. */
  elmHome?: string;
  /** Generate a TypeScript bindings, implies `module`. */
  typescript?: "node" | "deno";
  /** Turn on the time-travelling debugger. */
  debug?: boolean;
  /** List of find-and-replace transformations to apply. */
  transformations?: Transform[];
  /** Tune the optimization level. */
  optimize?: boolean | 0 | 1 | 2 | 3;
  /** Minify the output with terser. */
  minify?: boolean | MinifyOptions;
  /** Change how error messages are reported. This is only useful when running
  from the command-line interface as the provided functions do not capture the
  outputs.
   */
  report?: string;
  /** Generate a JSON file with the documentation. */
  docs?: string;
  /** Enable test mode. Can be used with `elm-test-rs` with the `--compiler` flag. */
  test?: boolean;
  /** Controls how `stdout` and `stderr` of the compiler should be handled.
   * Defaults to "inherit". Set to "piped" to access the output programmatically.
   */
  output?: "inherit" | "piped" | "null";
}

/** Simple find-and-replace rules applied to the compiled code. */
export interface Transform {
  /** Code to find. */
  find: string;

  /** Code to replace. */
  replace: string;
}

/** Compile and perform post-processing
 * @param inputs The input files to read.
 * @param output The name of the resulting JavaScript file.
 * @param options The compiler options.
 * @returns The status returned from the compiler.
 */
export async function elm(inputs: string[], output: string, options?: Options) {
  const config = {
    elmHome: options?.elmHome ?? DEFAULT_ELM_HOME,
    elmPath: options?.elmPath ?? "elm",
    projectRoot: options?.projectRoot ?? Deno.cwd(),
    module: path.extname(output) === ".mjs",
    typescript: options?.typescript,
    debug: options?.debug ?? false,
    transformations: options?.transformations ?? [],
    optimize: +(options?.optimize ?? 0) as 0 | 1 | 2 | 3,
    minify: options?.minify ?? false,
    report: options?.report,
    docs: options?.docs,
    test: options?.test ?? false,
    output: options?.output,
  };

  if (!config.module && config.typescript) {
    throw new ElmError(
      "Generating TypeScript bindings require building an ECMAScript module.",
    );
  }

  const needsTempFile = config.module ||
    config.transformations.length > 0 ||
    config.optimize > 1 ||
    config.minify;

  const out = needsTempFile ? `${await Deno.makeTempFile()}.js` : output;

  if (config.elmHome !== DEFAULT_ELM_HOME) {
    console.log(`export ELM_HOME=${config.elmHome}`);
  }

  if (config.projectRoot !== Deno.cwd()) console.log("cd", config.projectRoot);

  const args = [
    "make",
    ...inputs,
    ...(config.debug ? ["--debug"] : []),
    ...(config.optimize > 0 ? ["--optimize"] : []),
    `--output=${out}`,
    ...(config.report ? [`--report=${config.report}`] : []),
    ...(config?.docs ? [`--docs=${config.docs}`] : []),
  ];

  console.log(config.elmPath, ...args);

  const status = await run(args, config);
  if (!status.success || !needsTempFile) return status;

  await postprocess(out, output, config);

  return status;
}

/** Extra options for controlling the transformation cache. */
export interface ExtraOptions extends Options {
  /** Force refreshing the transformation cache. */
  refresh?: boolean;
}

/** Compile and perform post-processing.
 * Automatically loads transformations from the project and dependency
 * `README.md` files.
 * @param inputs The input files to read.
 * @param output The name of the resulting JavaScript file.
 * @param options The compiler options.
 * @returns The status returned from the compiler.
 */
export async function xelm(
  inputs: string[],
  output: string,
  options?: ExtraOptions,
) {
  const projectRoot = options?.projectRoot ?? Deno.cwd();
  const elmHome = options?.elmHome ?? DEFAULT_ELM_HOME;

  const transformations = await extractWithCache(
    projectRoot,
    elmHome,
    options?.test ?? false,
    options?.refresh ?? false,
  );

  if (options?.transformations !== undefined) {
    for (const transform of options?.transformations) {
      transformations.push(transform);
    }
  }

  return elm(inputs, output, {
    ...options,
    projectRoot,
    elmHome,
    transformations,
  });
}

/**
 * Executes the command-line interface (CLI).
 * @param args - An array of command-line arguments.
 * @returns The status returned from the compiler.
 */
export async function cli(args = Deno.args) {
  if (args[0] !== "make") return await run(args);

  const { inputs, output, options, transform } = await parseCliArgs(args);

  try {
    return transform
      ? xelm(inputs, output, options)
      : elm(inputs, output, options);
  } catch (e) {
    if (e instanceof ElmError) {
      console.error(e.message);
      Deno.exit(1);
    }

    throw e;
  }
}

// INTERNALS

const TERSER_CONFIG_JSON = "terser.config.json";
const ELM_JSON = "elm.json";
const README_MD = "README.md";
const ELM_STUFF = "elm-stuff";
const ELM_HOME = Deno.env.get("ELM_HOME");
const DEFAULT_ELM_HOME = ELM_HOME ?? `${Deno.env.get("HOME")}/.elm`;

export class ElmError extends Error {
  constructor(message: string) {
    super(message);
  }
}

// CLI

async function parseCliArgs(args: string[]) {
  const parsed = parse(args.slice(1, args.length), {
    string: [
      "output",
      "elm-home",
      "compiler",
      "project",
      "report",
      "docs",
    ],
    boolean: [
      "help",
      "debug",
      "minify",
      "transform",
      "test",
      "refresh",
    ],
  });

  const flags: Flags = {
    projectRoot: parsed.project,
    elmPath: parsed.compiler,
    elmHome: parsed["elm-home"],
  };

  if (parsed.help) {
    await help(flags);
    Deno.exit(0);
  }

  assertOutput(parsed.output);
  assertOptimize(parsed.optimize);
  assertTypescript(parsed.typescript);

  const inputs = parsed._.map((input) => input.toString());

  const options: ExtraOptions = {
    ...flags,
    typescript: typeof parsed.typescript === "boolean"
      ? (parsed.typescript ? "deno" : undefined)
      : (parsed.typescript ?? undefined),
    debug: parsed.debug,
    optimize: parsed.optimize,
    minify: parsed.minify
      ? (await getMinifyOptions(parsed.project) ?? parsed.minify)
      : parsed.minify,
    report: parsed.report,
    docs: parsed.docs,
    test: parsed.test,
    refresh: parsed.refresh,
  };

  return {
    inputs,
    output: parsed.output,
    options,
    transform: parsed.transform,
  };
}

if (import.meta.main) await cli();

// ELM

interface Flags {
  projectRoot?: string | undefined;
  elmHome?: string | undefined;
  elmPath?: string | undefined;
  output?: "inherit" | "piped" | "null";
}

async function run(args: string[], flags?: Flags) {
  return await new Deno.Command(flags?.elmPath ?? "elm", {
    args: [...args],
    cwd: flags?.projectRoot,
    env: flags?.elmHome ? { ELM_HOME: flags?.elmHome } : undefined,
    stdin: "null",
    stdout: flags?.output ?? "inherit",
    stderr: flags?.output ?? "inherit",
  }).spawn().status;
}

interface PostConfig {
  module: boolean;
  typescript?: "deno" | "node";
  debug: boolean;
  test: boolean;
  transformations: Transform[];
  optimize: 0 | 1 | 2 | 3;
  minify: boolean | MinifyOptions;
}

async function postprocess(src: string, dest: string, config: PostConfig) {
  let content = await Deno.readTextFile(src);

  if (config.transformations.length > 0) {
    content = transform(content, config);
  }

  if (config.module) {
    content = modularize(content);
    if (config.typescript) typescript(dest, config.typescript);
  }

  if (config.optimize > 1) {
    content = await optimize(content, config.optimize === 3);
  }

  if (config.minify !== false) {
    const minifyOptions = config.minify !== true ? config.minify : undefined;
    const result = await minify(content, minifyOptions);
    content = result.code ?? content;
  }

  await Deno.writeTextFile(dest, content);
}

function transform(content: string, config: PostConfig) {
  const map: { [find: string]: string } = {};
  const patterns: string[] = [];

  for (const { find, replace } of config.transformations) {
    const fmt = spacesToTabs(find);
    map[fmt] = preprocess(spacesToTabs(replace), config);
    const txt = escapeRegExp(fmt);
    patterns.push(txt);
  }

  const regexp = new RegExp(`(${patterns.join("|")})`, "gm");

  return content.replaceAll(regexp, (substring) => map[substring] ?? substring);
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
}

function spacesToTabs(content: string, spaces = "  ") {
  return content.replace(/^\s+/gm, (match) => match.replaceAll(spaces, "\t"));
}

function preprocess(content: string, config: PostConfig) {
  const lines: string[] = [];

  const vars = ["debug", "test"] as const;

  type Flags = typeof vars[number];
  const stack: { flag: Flags; cond: boolean }[] = [];

  lines:
  for (const line of content.split("\n")) {
    const [comment, cond, flag] = line.trim().split(/\s+/);

    if (comment === "//") {
      if (cond === "@IF" && vars.includes(flag as Flags)) {
        stack.push({ flag: flag as Flags, cond: true });
        continue lines;
      } else if (cond === "@UNLESS" && vars.includes(flag as Flags)) {
        stack.push({ flag: flag as Flags, cond: false });
        continue lines;
      } else if (cond === "@END") {
        stack.pop();
        continue lines;
      }
    }

    for (const { flag, cond } of stack) {
      if (cond !== (config[flag] ?? false)) continue lines;
    }

    lines.push(
      stack.length === 0 ? line : line.replace("\t".repeat(stack.length), ""),
    );
  }

  return lines.join("\n");
}

function modularize(content: string) {
  const pre = "(function(scope){\n'use strict';".length;
  const pos = "(this));".length;
  return `const scope = {};\n(function(scope){` +
    content.slice(pre, content.length - pos) +
    `(scope));\nexport default scope.Elm;`;
}

async function typescript(dest: string, runtime: "deno" | "node") {
  const { dir, name } = path.parse(dest);
  await Deno.writeTextFile(
    path.join(dir, `${name}.ts`),
    `/// <reference lib="dom" />
import elm from "./${name}${runtime === "deno" ? ".mjs" : ""}";
interface Elm {
  [module: Capitalize<string>]: Elm | undefined;
  init?: (options?: { node?: Node; flags?: unknown }) => {
    ports?: {
      [port: string]:
        | { send(value: unknown): void }
        | {
          subscribe(listener: (value: unknown) => void): void;
          unsubscribe(listener: (value: unknown) => void): void;
        }
        | undefined;
    };
  };
}
export const Elm: { [module: Capitalize<string>]: Elm | undefined } = elm;
`,
  );
}

// EXTRACT

async function extractWithCache(
  projectRoot: string,
  elmHome: string,
  test: boolean,
  refresh: boolean,
): Promise<Transform[]> {
  const transformationsFile = path.join(
    projectRoot,
    ELM_STUFF,
    "transformations.json",
  );

  const changed = refresh
    ? refresh
    : (await needsCacheRefresh(projectRoot, transformationsFile));

  if (!changed) {
    return JSON.parse(await Deno.readTextFile(transformationsFile));
  }

  const transformations = await extract(projectRoot, elmHome, test);

  await Deno.writeTextFile(
    transformationsFile,
    JSON.stringify(transformations),
  );

  return transformations;
}

async function extract(projectRoot: string, elmHome: string, test: boolean) {
  const elmJsonFile = path.join(projectRoot, ELM_JSON);

  const { version, dependencies } = await parseElmJson(elmJsonFile);

  const readmeFile = test
    ? path.join(projectRoot, "..", "..", README_MD)
    : path.join(projectRoot, README_MD);

  const name = test
    ? (await parseElmJson(path.join(projectRoot, "..", "..", ELM_JSON))).name
    : undefined;

  const transformations = await extractReadme(readmeFile, name);

  const directory = path.join(elmHome, version, "packages");

  for (const [dep, ver] of dependencies) {
    for (const transform of await extractDependency(dep, ver, directory)) {
      transformations.push(transform);
    }
  }

  return transformations;
}

async function parseElmJson(filePath: string) {
  if (!await fs.exists(filePath)) {
    throw new ElmError(`Could not find '${ELM_JSON}' at ${filePath}`);
  }

  type StringRecord = Record<string, string>;

  type Dependencies = { direct: StringRecord; indirect: StringRecord };

  type ElmJson = {
    ["name"]: string;
    dependencies: Dependencies;
    ["elm-version"]: string;
  };

  const elmJson: ElmJson = JSON.parse(await Deno.readTextFile(filePath));

  const version = elmJson["elm-version"];

  if (version === undefined) {
    throw new ElmError(`Undefined "elm-version" field in '${ELM_JSON}'`);
  }

  const { direct, indirect } = elmJson["dependencies"] ?? {};

  const dependencies = Object.entries(direct ?? {}).concat(
    Object.entries(indirect ?? {}),
  );

  return { name: elmJson.name, version, dependencies };
}

async function extractDependency(
  dependency: string,
  version: string,
  directory: string,
) {
  const [author, name] = dependency.split("/");

  if (author === undefined) {
    console.error("Undefined package author");
  }

  if (name === undefined) {
    console.error("Undefined package name");
  }

  const markdownFile = path.join(
    directory,
    author,
    name,
    version,
    README_MD,
  );

  return await extractReadme(markdownFile);
}

async function extractReadme(filePath: string, namespace?: string) {
  if (!await fs.exists(filePath)) return [];

  const regExp = namespace ? getNamespace(namespace) : undefined;
  const content = await Deno.readTextFile(filePath);

  const transforms: Transform[] = [];

  let collect = false;
  let find: string | undefined = undefined;

  for (const token of marked.lexer(content)) {
    if (collect && token.type === "heading" && token.depth < 4) break;

    if (!collect && token.type === "paragraph") {
      for (const item of token.tokens) {
        if (
          item.type === "link" &&
          item.href === "#98f5c378-5809-4e35-904e-d1c5c3a8154e"
        ) {
          collect = true;
          break;
        }
      }
    }

    if (collect && token.type === "code") {
      if (token.lang !== "js") {
        throw new ElmError(`Unexpected '${token.lang}' code block`);
      }

      const text = regExp
        ? token.text.replaceAll(regExp, "$author$project$")
        : token.text;

      if (find !== undefined) {
        transforms.push({ find, replace: spacesToTabs(text, "    ") });
        find = undefined;
      } else {
        find = spacesToTabs(text, "    ");
      }
    }
  }

  if (find !== undefined) {
    throw new ElmError(
      `Unmatched find-and-replace transformation pattern:\n\n${find}`,
    );
  }

  return transforms;
}

function getNamespace(name: string) {
  const [author, project] = escapeVar(name).split("/");

  if (author === undefined) {
    throw new ElmError(`Could not extract author name from ${ELM_JSON}`);
  }

  if (project === undefined) {
    throw new ElmError(`Could not extract project name from ${ELM_JSON}`);
  }

  const authorPart = escapeRegExp(escapeVar(author));

  const projectPart = escapeRegExp(escapeVar(project));

  return new RegExp(
    `\\\$${authorPart}\\\$${projectPart}\\\$`,
    "gm",
  );
}

function escapeVar(name: string) {
  // TODO: proper escape
  return name.replace(/\-/gm, "_");
}

// CACHE

async function needsCacheRefresh(
  projectRoot: string,
  transformationsFile: string,
) {
  if (!await fs.exists(transformationsFile)) return true;

  const dependenciesChanged = await isModifiedAfter(
    path.join(projectRoot, ELM_JSON),
    transformationsFile,
  );

  const readmeChanged = await isModifiedAfter(
    path.join(projectRoot, README_MD),
    transformationsFile,
  );

  return dependenciesChanged || readmeChanged;
}

async function isModifiedAfter(src: string, dest: string) {
  const srcTime = await getModificationTime(src, Number.POSITIVE_INFINITY);
  const destTime = await getModificationTime(dest, 0);
  return srcTime > destTime;
}

async function getModificationTime(filePath: string, fallback: number) {
  try {
    return (await Deno.stat(filePath)).mtime?.getTime() ?? fallback;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return fallback;
    throw e;
  }
}

// CLI

async function help(flags: Flags) {
  await run(["make", "--help"], flags);

  const l = console.log.bind(console);
  const h = (s: string) => console.log(colorize(s));

  l("Expanded flags:");
  l("");
  h("    --output=<output-file>");
  l("        Expanded to build ECMAScript modules. For example");
  l("        --output=assets/elm.mjs to generate the module at assets/elm.mjs");
  l("");
  h("    --optimize=0");
  l("        Disable all optimizations.");
  l("");
  h("    --optimize=1");
  l("        Same as running `elm make --optimize`.");
  l("");
  h("    --optimize=2");
  l("        Same as running `elm-optimize-level-2`.");
  l("");
  h("    --optimize=3");
  l("        Same as running `elm-optimize-level-2 --optimize-speed`.");
  l("");
  h("    --compiler=<elm-binary>");
  l("        The path to the Elm binary, which is `elm` by default.");
  l("");
  h("    --project=<project-root>");
  l("        Path to the root directory of the project.");
  l("        Defaults to the current working directory.");
  l("");
  h("    --elm-home=<elm-home>");
  l("        Use a custom directory for ELM_HOME, which is `~/.elm` by default.");
  if ((ELM_HOME ?? "") !== "") {
    l(`        [env: ELM_HOME=${Deno.env.get("ELM_HOME")}]`);
  }
  l("");
  h("    --typescript=<runtime>");
  l("        Generate TypeScript bindings for the given runtime. For example,");
  l("        --typescript=node generates bindings for Node.js. Defaults to deno and");
  l("        requires a `.mjs` output.");
  l("");
  h("    --minify");
  l(`       Minify the output with terser, loading configuration from`);
  l(`       \`${TERSER_CONFIG_JSON}\` if available.`);
  l("");
  h("    --transform");
  l("        Enable loading find-and-replace transformations from `README.md` files.");
  l("");
  h("    --test");
  l("        Load find-and-replace transformations from test dependencies.");
  l("");
  h("    --refresh");
  l("        Refresh find-and-replace transformation cache.");
}

function assertOutput(
  output: unknown,
): asserts output is string {
  if (typeof output !== "string") throw new ElmError("No output file");
  if (![".js", ".mjs"].includes(path.extname(output))) {
    throw new ElmError("Output must be JavaScript or ECMAScript module");
  }
}

function assertOptimize(
  optimize: unknown,
): asserts optimize is Options["optimize"] {
  if (optimize === undefined || typeof optimize === "boolean") return;
  if (typeof optimize === "number" && (optimize < 0 || optimize > 3)) {
    throw new ElmError(`Invalid optimization level ${optimize}`);
  }
}

function assertTypescript(
  typescript: unknown,
): asserts typescript is Options["typescript"] {
  if (typescript === undefined || typeof typescript === "boolean") return;
  if (typescript !== "deno" && typescript !== "node") {
    throw new ElmError(`Invalid TypeScript format ${typescript}`);
  }
}

async function getMinifyOptions(projectRoot?: string) {
  const terserFile = path.join(projectRoot ?? Deno.cwd(), TERSER_CONFIG_JSON);

  if (!await fs.exists(terserFile)) return undefined;

  try {
    return JSON.parse(await Deno.readTextFile(terserFile));
  } catch (e) {
    throw new ElmError(
      `Could not parse \`${TERSER_CONFIG_JSON}\`: ${e.message}`,
    );
  }
}
