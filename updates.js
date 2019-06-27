#!/usr/bin/env node
"use strict";

process.env.NODE_ENV = "production";

const npmRegisty = "https://registry.npmjs.org/";

const args = require("minimist")(process.argv.slice(2), {
  boolean: [
    "c", "color",
    "E", "error-on-outdated",
    "h", "help",
    "j", "json",
    "n", "no-color",
    "u", "update",
    "v", "version",
  ],
  string: [
    "f", "file",
    "g", "greatest",
    "m", "minor",
    "P", "patch",
    "p", "prerelease",
    "R", "release",
    "r", "registry",
    "t", "types",
  ],
  alias: {
    c: "color",
    E: "error-on-outdated",
    e: "exclude",
    f: "file",
    g: "greatest",
    h: "help",
    i: "include",
    j: "json",
    m: "minor",
    n: "no-color",
    P: "patch",
    p: "prerelease",
    r: "registry",
    R: "release",
    s: "semver",
    t: "types",
    u: "update",
    v: "version",
  },
});

if (args.help) {
  process.stdout.write(`usage: updates [options]

  Options:
    -u, --update                  Update versions and write package.json
    -p, --prerelease [<pkg,...>]  Consider prerelease versions
    -R, --release [<pkg,...>]     Only use release versions, may downgrade
    -g, --greatest [<pkg,...>]    Prefer greatest over latest version
    -i, --include <pkg,...>       Include only given packages
    -e, --exclude <pkg,...>       Exclude given packages
    -t, --types <type,...>        Check only given dependency types
    -P, --patch [<pkg,...>]       Consider only up to semver-patch
    -m, --minor [<pkg,...>]       Consider only up to semver-minor
    -E, --error-on-outdated       Exit with error code 2 on outdated packages
    -r, --registry <url>          Use given registry URL
    -f, --file <path>             Use given package.json file or module directory
    -j, --json                    Output a JSON object
    -c, --color                   Force-enable color output
    -n, --no-color                Disable color output
    -v, --version                 Print the version
    -h, --help                    Print this help

  Examples:
    $ updates
    $ updates -u
    $ updates -u -m
    $ updates -u -e chalk
    $ updates -u -t devDependencies
`);
  process.exit(0);
}

const path = require("path");

if (args.version) {
  console.info(require(path.join(__dirname, "package.json")).version);
  process.exit(0);
}

if (args["no-color"]) {
  process.env.FORCE_COLOR = "0";
} else if (args["color"] || process.stdout.isTTY === undefined) { // winpty compat
  process.env.FORCE_COLOR = "1";
}

const greatest = parseMixedArg(args.greatest);
const prerelease = parseMixedArg(args.prerelease);
const release = parseMixedArg(args.release);
const patch = parseMixedArg(args.patch);
const minor = parseMixedArg(args.minor);

const chalk = require("chalk");

let registry;
if (args.registry) {
  registry = args.registry;
} else {
  try {
    registry = require("npm-conf")().get("registry");
  } catch (err) {
    registry = npmRegisty;
  }
}
registry = normalizeRegistryUrl(registry);

let packageFile;
const deps = {};

if (args.file) {
  let stat;
  try {
    stat = require("fs").lstatSync(args.file);
  } catch (err) {
    finish(new Error(`Unable to open ${args.file}: ${err.message}`));
  }

  if (stat && stat.isFile()) {
    packageFile = args.file;
  } else if (stat && stat.isDirectory()) {
    packageFile = path.join(args.file, "package.json");
  } else {
    finish(new Error(`${args.file} is neither a file nor directory`));
  }
} else {
  packageFile = require("find-up").sync("package.json");
  if (!packageFile) {
    finish(new Error(`Unable to find package.json in ${process.cwd()} or any of its parent directories`));
  }
}

let dependencyTypes;
if (args.types) {
  dependencyTypes = Array.isArray(args.types) ? args.types : args.types.split(",");
} else {
  dependencyTypes = [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ];
}

const fs = require("fs");
let pkg, pkgStr;

try {
  pkgStr = fs.readFileSync(packageFile, "utf8");
} catch (err) {
  finish(new Error(`Unable to open package.json: ${err.message}`));
}

try {
  pkg = JSON.parse(pkgStr);
} catch (err) {
  finish(new Error(`Error parsing package.json: ${err.message}`));
}

const semver = require("semver");

let include, exclude;
if (args.include && args.include !== true) include = args.include.split(",");
if (args.exclude && args.exclude !== true) exclude = args.exclude.split(",");

for (const key of dependencyTypes) {
  if (pkg[key]) {
    const names = Object.keys(pkg[key])
      .filter(name => !include ? true : include.includes(name))
      .filter(name => !exclude ? true : !exclude.includes(name));

    for (const name of names) {
      const old = pkg[key][name];
      if (isValidSemverRange(old)) {
        deps[name] = {old};
      }
    }
  }
}

if (!Object.keys(deps).length) {
  if (include || exclude) {
    finish(new Error("No packages match the given filters"));
  } else {
    finish(new Error("No packages found"));
  }
}

const fetch = require("make-fetch-happen");
const hostedGitInfo = require("hosted-git-info");
const registryAuthToken = require("registry-auth-token");
const registryUrl = require("registry-auth-token/registry-url");

function getAuthAndRegistry(name, registry) {
  let auth;

  try {
    if (!name.startsWith("@")) {
      auth = registryAuthToken(registry);
    } else {
      const scope = (/@[a-z0-9][\w-.]+/.exec(name) || [])[0];
      const url = normalizeRegistryUrl(registryUrl(scope));
      if (url !== registry) {
        try {
          const newAuth = registryAuthToken(url);
          if (newAuth && newAuth.token) {
            auth = newAuth;
            registry = url;
          }
        } catch (err) {}
      }
    }
  } catch (err) {
    finish(err);
  }

  return [auth, registry];
}

function fetchFromRegistry(name, registry, auth) {
  // on scoped packages replace "/" with "%2f"
  if (/@[a-z0-9][\w-.]+\/[a-z0-9][\w-.]*/gi.test(name)) {
    name = name.replace(/\//g, "%2f");
  }

  const opts = (auth && auth.token) ? {headers: {Authorization: `Bearer ${auth.token}`}} : undefined;
  return fetch(`${registry}/${name}`, opts);
}

const get = async (name, originalRegistry) => {
  const [auth, registry] = getAuthAndRegistry(name, originalRegistry);

  let res = await fetchFromRegistry(name, registry, auth);
  if (registry === npmRegisty || (res.status >= 200 && res.status < 300)) {
    return [await res.json(), registry];
  } else { // retry on official registry if custom registry fails
    res = await fetchFromRegistry(name, npmRegisty);
    if (res.status >= 200 && res.status < 300) {
      return [await res.json(), registry];
    } else {
      throw new Error(`Received ${res.status} ${res.statusText} for ${name}`);
    }
  }
};

const getInfoUrl = ({repository, homepage}, registry, name) => {
  if (registry === "https://npm.pkg.github.com") {
    return `https://github.com/${name.replace(/^@/, "")}`;
  } else if (repository) {
    const gitUrl = typeof repository === "string" ? repository : repository.url;
    const info = hostedGitInfo.fromUrl(gitUrl);
    if (info && info.browse) return info.browse();
  }

  return homepage || "";
};

Promise.all(Object.keys(deps).map(name => get(name, registry))).then(dati => {
  for (const [data, registry] of dati) {
    if (data && data.error) {
      throw new Error(data.error);
    }

    const useGreatest = typeof greatest === "boolean" ? greatest : greatest.includes(data.name);
    const usePre = typeof prerelease === "boolean" ? prerelease : prerelease.includes(data.name);
    const useRel = typeof release === "boolean" ? release : release.includes(data.name);

    let semvers;
    if (patch === true || Array.isArray(patch) && patch.includes(data.name)) {
      semvers = ["patch"];
    } else if (minor === true || Array.isArray(minor) && minor.includes(data.name)) {
      semvers = ["patch", "minor"];
    } else {
      semvers = ["patch", "minor", "major"];
    }

    const oldRange = deps[data.name].old;
    const newVersion = findNewVersion(data, {usePre, useRel, useGreatest, semvers, range: oldRange});
    const newRange = updateRange(oldRange, newVersion);

    if (!newVersion || oldRange === newRange) {
      delete deps[data.name];
    } else {
      deps[data.name].new = newRange;
      deps[data.name].info = getInfoUrl(data.versions[newVersion] || data, registry, data.name);
    }
  }

  if (!Object.keys(deps).length) {
    finish("All packages are up to date.");
  }

  if (!args.update) {
    finish();
  }

  try {
    fs.writeFileSync(packageFile, updatePkg(), "utf8");
  } catch (err) {
    finish(new Error(`Error writing package.json: ${err.message}`));
  }

  finish(chalk.green(`
 ╭────────────────────────╮
 │  package.json updated  │
 ╰────────────────────────╯`.substring(1)));
}).catch(finish);

function finish(obj, opts = {}) {
  const output = {};
  const hadError = obj instanceof Error;

  if (typeof obj === "string") {
    output.message = obj;
  } else if (hadError) {
    output.error = obj.stack;
  }

  if (args.json) {
    if (!hadError) {
      output.results = deps;
    }
    console.info(JSON.stringify(output));
  } else {
    if (Object.keys(deps).length && !hadError) {
      console.info(formatDeps(deps));
    }
    if (output.message || output.error) {
      if (output.message) {
        console.info(output.message);
      } else if (output.error) {
        const lines = output.error.split(/\r?\n/);
        for (const [index, line] of Object.entries(lines)) {
          console.info(chalk[index === "0" ? "red" : "grey"](line));
        }
      }
    }
  }

  if (args["error-on-outdated"]) {
    process.exit(Object.keys(deps).length ? 2 : 0);
  } else {
    process.exit(opts.exitCode || (output.error ? 1 : 0));
  }
}

function normalizeRegistryUrl(url) {
  return url.endsWith("/") ? url.substring(0, url.length - 1) : url;
}

function highlightDiff(a, b, added) {
  const aParts = a.split(/\./);
  const bParts = b.split(/\./);
  const color = chalk[added ? "green" : "red"];
  const versionPartRe = /^[0-9a-zA-Z-.]+$/;
  let res = "";

  for (let i = 0; i < aParts.length; i++) {
    if (aParts[i] !== bParts[i]) {
      if (versionPartRe.test(aParts[i])) {
        res += color(aParts.slice(i).join("."));
      } else {
        res += aParts[i].split("").map(char => {
          return versionPartRe.test(char) ? color(char) : char;
        }).join("") + color("." + aParts.slice(i + 1).join("."));
      }
      break;
    } else {
      res += aParts[i] + ".";
    }
  }

  return res;
}

function formatDeps() {
  const arr = [["NAME", "OLD", "NEW", "INFO"]];

  for (const [name, data] of Object.entries(deps)) arr.push([
    name,
    highlightDiff(data.old, data.new, false),
    highlightDiff(data.new, data.old, true),
    data.info,
  ]);

  return require("text-table")(arr, {
    hsep: " ".repeat(4),
    stringLength: require("string-width"),
  });
}

function updatePkg() {
  const esc = require("escape-string-regexp");
  let newPkgStr = pkgStr;

  for (const dep of Object.keys(deps)) {
    const re = new RegExp(`"${esc(dep)}": +"${esc(deps[dep].old)}"`, "g");
    newPkgStr = newPkgStr.replace(re, `"${dep}": "${deps[dep].new}"`);
  }

  return newPkgStr;
}

function updateRange(range, version) {
  return range.replace(/[0-9]+\.[0-9]+\.[0-9]+(-.+)?/g, version);
}

function isValidSemverRange(range) {
  let valid = false;
  try {
    semver.Range(range);
    valid = true;
  } catch (err) {}
  return valid;
}

function isVersionPrerelease(version) {
  const parsed = semver.parse(version);
  if (!parsed) return false;
  return Boolean(parsed.prerelease.length);
}

function isRangePrerelease(range) {
  // can not use semver.coerce here because it ignores prerelease tags
  return /[0-9]+\.[0-9]+\.[0-9]+-.+/.test(range);
}

function rangeToVersion(range) {
  try {
    return semver.coerce(range).version;
  } catch (err) {
    return null;
  }
}

function findVersion(data, versions, opts) {
  let tempVersion = rangeToVersion(opts.range);
  let tempDate = 0;

  const semvers = opts.semvers.slice();
  const usePre = isRangePrerelease(opts.range) || opts.usePre;

  if (usePre) {
    semvers.push("prerelease");
    if (semvers.includes("patch")) semvers.push("prepatch");
    if (semvers.includes("minor")) semvers.push("preminor");
    if (semvers.includes("major")) semvers.push("premajor");
  }

  for (const version of versions) {
    const parsed = semver.parse(version);
    if (parsed.prerelease.length && (!usePre || opts.useRel)) continue;

    const diff = semver.diff(tempVersion, parsed.version);
    if (!diff || !semvers.includes(diff)) continue;

    if (opts.useGreatest || !("time" in data)) { // some registries like github don't have data.time available, fall back to greatest on them
      if (semver.gte(semver.coerce(parsed.version).version, tempVersion)) {
        tempVersion = parsed.version;
      }
    } else {
      const date = (new Date(data.time[version])).getTime();
      if (date >= 0 && date > tempDate) {
        tempVersion = parsed.version;
        tempDate = date;
      }
    }
  }

  return tempVersion || null;
}

function findNewVersion(data, opts) {
  if (opts.range === "*") return "*";
  const versions = Object.keys(data.versions).filter(version => semver.valid(version));
  const version = findVersion(data, versions, opts);

  if (opts.useGreatest) {
    return version;
  } else {
    const latestTag = data["dist-tags"].latest;
    const oldVersion = semver.coerce(opts.range).version;
    const oldIsPre = isRangePrerelease(opts.range);
    const newIsPre = isVersionPrerelease(version);
    const isGreater = semver.gt(version, oldVersion);

    // update to new prerelease
    if (!opts.useRel && opts.usePre || (oldIsPre && newIsPre)) {
      return version;
    }

    // downgrade from prerelease to release on --release-only
    if (opts.useRel && !isGreater && oldIsPre && !newIsPre) {
      return version;
    }

    // update from prerelease to release
    if (oldIsPre && !newIsPre && isGreater) {
      return version;
    }

    // do not downgrade from prerelease to release
    if (oldIsPre && !newIsPre && !isGreater) {
      return null;
    }

    // check if latestTag is allowed by semvers
    const diff = semver.diff(oldVersion, latestTag);
    if (diff && diff !== "prerelease" && !opts.semvers.includes(diff.replace(/^pre/, ""))) {
      return version;
    }

    // prevent upgrading to prerelease with --release-only
    if (opts.useRel && isVersionPrerelease(latestTag)) {
      return version;
    }

    // in all other cases, return latest dist-tag
    return latestTag;
  }
}

function parseMixedArg(arg) {
  if (arg === "") {
    return true;
  } else if (typeof arg === "string") {
    return arg.includes(",") ? arg.split(",") : [arg];
  } else if (Array.isArray(arg)) {
    return arg;
  } else {
    return false;
  }
}
