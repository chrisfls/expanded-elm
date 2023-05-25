#!/usr/bin/env -S deno run -A
import { cyan as colorize } from "https://deno.land/std@0.188.0/fmt/colors.ts";
import { parse } from "https://deno.land/std@0.188.0/flags/mod.ts";
import * as fs from "https://deno.land/std@0.188.0/fs/mod.ts";
import * as path from "https://deno.land/std@0.188.0/path/mod.ts";
import { Liquid } from "https://esm.sh/liquidjs@10.7.1";
import { marked } from "https://esm.sh/marked@5.0.2";
import { minify, MinifyOptions } from "https://esm.sh/terser@5.17.6";
import { transform as optimize } from "https://esm.sh/elm-optimize-level-2@0.3.5/dist/index.js?deps=typescript@4.7.4";
import escapeStringRegexp from "https://esm.sh/escape-string-regexp@5.0.0";

/** Compiler options. */
export interface Options {
  /** Path to the root directory of the project. */
  projectRoot?: string;
  /** The path to the Elm binary. */
  elmPath?: string;
  /** Custom directory for ELM_HOME, which is `~/.elm` by default. */
  elmHome?: string;
  /** Enable a patch for running Elm in Deno. */
  deno?: boolean;
  /** Turn on the time-travelling debugger. */
  debug?: boolean;
  /** List of find-and-replace transformations to apply. */
  transformations?: Transform[];
  /** Tune the optimization level. */
  optimize?: boolean | 0 | 1 | 2 | 3;
  /** Minify the output with terser. */
  minify?: boolean | MinifyOptions;
  /** Get error messages as JSON. This is only useful when running
  from the command-line interface as the provided functions do not capture the
  outputs.
   */
  report?: "json";
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
    deno: options?.deno ?? false,
    debug: options?.debug ?? false,
    transformations: options?.transformations ?? [],
    optimize: +(options?.optimize ?? 0) as 0 | 1 | 2 | 3,
    minify: options?.minify ?? false,
    report: options?.report,
    docs: options?.docs,
    test: options?.test ?? false,
  };

  const needsTempFile = config.deno ||
    config.transformations.length > 0 ||
    config.optimize > 1 ||
    config.minify;

  const out = needsTempFile ? `${await Deno.makeTempFile()}.js` : output;

  if (config.elmHome !== ELM_HOME) console.log(`export HOME=${config.elmHome}`);
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
): Promise<Deno.ProcessStatus> {
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
      "deno",
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

  const inputs = parsed._.map((input) => input.toString());

  const options: ExtraOptions = {
    ...flags,
    deno: parsed.deno,
    debug: parsed.debug,
    optimize: parsed.optimize,
    minify: parsed.minify
      ? (await getMinifyOptions(parsed.project) ?? parsed.minify)
      : parsed.minify,
    report: parsed.report as undefined | "json",
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
  return await Deno.run({
    cwd: flags?.projectRoot,
    env: flags?.elmHome ? { ELM_HOME: flags?.elmHome } : undefined,
    cmd: [flags?.elmPath ?? "elm", ...args],
  }).status();
}

interface PostConfig {
  deno: boolean;
  debug: boolean;
  test: boolean;
  transformations: Transform[];
  optimize: 0 | 1 | 2 | 3;
  minify: boolean | MinifyOptions;
}

async function postprocess(src: string, dest: string, config: PostConfig) {
  let content = await Deno.readTextFile(src);

  if (config.transformations.length > 0) {
    content = await transform(content, config);
  }

  if (config.deno) {
    content = deno(content);
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

async function transform(content: string, config: PostConfig) {
  const engine = new Liquid();
  const map: { [find: string]: string } = {};
  const patterns: string[] = [];
  const vars = { debug: config.debug, test: config.test };

  for (const { find, replace } of config.transformations) {
    const fmt = spacesToTabs(find.trim());

    map[fmt] = spacesToTabs(
      await engine.render(engine.parse(replace), vars),
    );

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

function deno(content: string) {
  return content.replace(/\(this\)\)\;$/g, "(globalThis));");
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

  l("Extended flags:");
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
  h("    --deno");
  l("        Enable a patch for running Elm in Deno.");
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
