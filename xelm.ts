#!/usr/bin/env -S deno run -A
import { cyan as colorize } from "https://deno.land/std@0.188.0/fmt/colors.ts";
import { parse } from "https://deno.land/std@0.188.0/flags/mod.ts";
import * as fs from "https://deno.land/std@0.188.0/fs/mod.ts";
import * as path from "https://deno.land/std@0.188.0/path/mod.ts";
import { marked } from "https://esm.sh/marked@5.0.2";
import { minify, MinifyOptions } from "https://esm.sh/terser@5.17.6";
import "npm:typescript@4.7.4";
import { transform as optimize } from "npm:elm-optimize-level-2@0.3.5";
import escapeStringRegexp from "https://esm.sh/escape-string-regexp@5.0.0";

/** Compiler options. */
export interface Options {
  /** Path to the root directory of the project. */
  projectRoot?: string;
  /** The path to the Elm binary. */
  elmPath?: string;
  /** Custom directory for ELM_HOME, which is `~/.elm` by default. */
  elmHome?: string;
  /** Build an ECMAScript module. */
  module?: boolean;
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
  /** Load transformations from test dependencies. */
  test?: boolean;
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
    module: options?.typescript ? true : (options?.module ?? false),
    typescript: options?.typescript ?? "deno",
    debug: options?.debug ?? false,
    transformations: options?.transformations ?? [],
    optimize: +(options?.optimize ?? 0) as 0 | 1 | 2 | 3,
    minify: options?.minify ?? false,
    report: options?.report,
    docs: options?.docs,
    test: options?.test ?? false,
  };

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

// INTERNALS

const TERSER_CONFIG_JSON = "terser.config.json";
const ELM_JSON = "elm.json";
const README_MD = "README.md";
const ELM_STUFF = "elm-stuff";
const ELM_HOME = Deno.env.get("ELM_HOME");
const DEFAULT_ELM_HOME = ELM_HOME ?? `${Deno.env.get("HOME")}/.elm`;

// CLI

async function cli(args: string[]) {
  if (args[0] !== "make") return await run(args);

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
      "module",
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

  if (parsed.help) return await help(flags);

  assertOutput(parsed.output);
  assertOptimize(parsed.optimize);
  assertTypescript(parsed.typescript);

  const inputs = parsed._.map((input) => input.toString());

  const options: ExtraOptions = {
    ...flags,
    module: parsed.typescript ? true : parsed.module,
    typescript: typeof parsed?.typescript === "boolean"
      ? (parsed?.typescript ? "deno" : undefined)
      : (parsed?.typescript ?? undefined),
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

  return parsed.transform
    ? xelm(inputs, parsed.output, options)
    : elm(inputs, parsed.output, options);
}

if (import.meta.main) await cli(Deno.args);

// ELM

interface Flags {
  projectRoot?: string | undefined;
  elmHome?: string | undefined;
  elmPath?: string | undefined;
}

async function run(args: string[], flags?: Flags) {
  return await new Deno.Command(flags?.elmPath ?? "elm", {
    args: [...args],
    cwd: flags?.projectRoot,
    env: flags?.elmHome ? { ELM_HOME: flags?.elmHome } : undefined,
  }).spawn().status;
}

interface PostConfig {
  module: boolean;
  typescript: "deno" | "node";
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
    const fmt = spacesToTabs(find.trim());
    map[fmt] = preprocess(spacesToTabs(replace), config);
    patterns.push(escapeStringRegexp(fmt));
  }

  const regexp = new RegExp(`(${patterns.join("|")})`, "gm");

  return content.replaceAll(regexp, (substring) => map[substring] ?? substring);
}

function spacesToTabs(find: string) {
  const regexp = /^\s{2}/gm;

  while (true) {
    const value = find.replace(regexp, "\t");
    if (value === find) break;
    find = value;
  }

  return find;
}

function preprocess(content: string, config: PostConfig) {
  const lines: string[] = [];

  const check = ["debug", "test", "module"] as const;

  type Flags = typeof check[number];
  const stack: Flags[] = [];

  lines:
  for (const line of content.split("\n")) {
    const [comment, cond, flag] = line.trim().split(/\s+/);

    if (comment === "//") {
      if (cond === "@IF" && check.includes(flag as Flags)) {
        stack.push(flag as Flags);
        continue lines;
      } else if (cond === "@FI") {
        stack.pop();
        continue lines;
      }
    }

    for (const flag of stack) if (!config[flag]) continue lines;

    lines.push(
      stack.length === 0 ? line : line.replace("\t".repeat(stack.length), ""),
    );
  }

  return lines.join("\n");
}

function modularize(content: string) {
  return `const scope = {};\n${
    content.replace(/\(this\)\)\;$/g, "(scope));")
  }\n export default scope.Elm;`;
}

async function typescript(dest: string, runtime: "deno" | "node") {
  const name = path.join(dest.slice(0, -path.extname(dest).length))
  const deno = runtime === "deno";
  await Deno.writeTextFile(
    `${name}.ts`,
    `/// <reference lib="dom" />
import elm from "./${name}${deno ? ".js" : ""}";
interface Module {
  [module: Capitalize<string>]: Module | undefined;
  init?: (options?: { node?: Node; flags?: unknown }) => {
    ports: {
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
interface Elm {
  [module: Capitalize<string>]: Module | undefined;
}
export default elm as Elm;
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
  const transformationsFile = test
    ? path.join(projectRoot, ELM_STUFF, "transformations.test.json")
    : path.join(projectRoot, ELM_STUFF, "transformations.json");

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
  const readmeFile = path.join(projectRoot, README_MD);
  const transformations = await extractReadme(readmeFile);

  const elmJsonFile = path.join(projectRoot, ELM_JSON);
  const { version, dependencies } = await parseElmJson(elmJsonFile, test);
  const directory = path.join(elmHome, version, "packages");

  for (const [dep, ver] of dependencies) {
    for (const transform of await extractDependency(dep, ver, directory)) {
      transformations.push(transform);
    }
  }

  return transformations;
}

async function parseElmJson(filePath: string, test: boolean) {
  if (!await fs.exists(filePath)) {
    exit(`Could not find '${ELM_JSON}' at ${filePath}`);
  }

  type StringRecord = Record<string, string>;

  type Dependencies = { direct: StringRecord; indirect: StringRecord };

  type ElmJson = {
    dependencies: Dependencies;
    ["test-dependencies"]: Dependencies;
    ["elm-version"]: string;
  };

  const elmJson: ElmJson = JSON.parse(await Deno.readTextFile(filePath));

  const version = elmJson["elm-version"];

  if (version === undefined) {
    exit(`Undefined "elm-version" field in '${ELM_JSON}'`);
  }

  const { direct, indirect } =
    elmJson[test ? "test-dependencies" : "dependencies"] ?? {};

  const dependencies = Object.entries(direct ?? {}).concat(
    Object.entries(indirect ?? {}),
  );

  return { version, dependencies };
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

async function extractReadme(filePath: string) {
  if (!await fs.exists(filePath)) return [];

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
      if (token.lang !== "js") exit(`Unexpected '${token.lang}' code block`);
      if (find !== undefined) {
        transforms.push({ find, replace: token.text });
        find = undefined;
      } else {
        find = token.text;
      }
    }
  }

  if (find !== undefined) {
    exit(`Unmatched find-and-replace transformation pattern:\n\n${find}`);
  }

  return transforms;
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
  h("    --module");
  l("        Build an ECMAScript module.");
  l("");
  h("    --typescript=<runtime>");
  l("        Generate TypeScript bindings for the given runtime. For example,");
  l("        --typescript=node generates bindings for Node.js. Defaults to deno and");
  l("        implies --module.");
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
  if (typeof output !== "string") exit("No output file");
  if (path.extname(output) !== ".js") exit("Output must be JavaScript");
}

function assertOptimize(
  optimize: unknown,
): asserts optimize is Options["optimize"] {
  if (optimize === undefined || typeof optimize === "boolean") return;
  if (typeof optimize === "number" && (optimize < 0 || optimize > 3)) {
    exit(`Invalid optimization level ${optimize}`);
  }
}

function assertTypescript(
  typescript: unknown,
): asserts typescript is Options["typescript"] {
  if (typescript === undefined || typeof typescript === "boolean") return;
  if (typescript !== "deno" && typescript !== "node") {
    exit(`Invalid TypeScript format ${typescript}`);
  }
}

async function getMinifyOptions(projectRoot?: string) {
  const terserFile = path.join(projectRoot ?? Deno.cwd(), TERSER_CONFIG_JSON);

  if (!await fs.exists(terserFile)) return undefined;

  try {
    return JSON.parse(await Deno.readTextFile(terserFile));
  } catch (e) {
    exit(`Could not parse \`${TERSER_CONFIG_JSON}\`: ${e.message}`);
  }
}

// UTIL

function exit(message: string): never {
  if (import.meta.main) {
    console.error(message);
    Deno.exit(1);
  }

  throw new Error(message);
}
