#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);

function readJson(path) {
  return JSON.parse(readFileSync(resolve(root, path), "utf8"));
}

function fail(message) {
  console.error(`[runtime-contract] ${message}`);
  process.exit(1);
}

const packageJson = readJson("package.json");
const expected =
  packageJson.dependencies && packageJson.dependencies["@delta/runtime-contract"];

if (!expected) {
  fail("package.json is missing dependencies.@delta/runtime-contract");
}

const packageLock = readJson("package-lock.json");
const lockRoot = packageLock.packages && packageLock.packages[""];
const lockRootSpec =
  lockRoot && lockRoot.dependencies && lockRoot.dependencies["@delta/runtime-contract"];
const lockNode =
  packageLock.packages && packageLock.packages["node_modules/@delta/runtime-contract"];

if (lockRootSpec !== expected) {
  fail(
    `package-lock root spec is stale: expected ${expected}, got ${
      lockRootSpec || "<missing>"
    }`
  );
}

if (!lockNode || lockNode.resolved !== expected) {
  fail(
    `package-lock resolved tarball is stale: expected ${expected}, got ${
      (lockNode && lockNode.resolved) || "<missing>"
    }`
  );
}

const pnpmLockText = readFileSync(resolve(root, "pnpm-lock.yaml"), "utf8");
const pnpmRuntimeLines = pnpmLockText
  .split("\n")
  .filter((line) => line.includes("delta-runtime-contract/archive/"));

if (pnpmRuntimeLines.length === 0) {
  fail("pnpm-lock.yaml is missing @delta/runtime-contract tarball references");
}

const stalePnpmLines = pnpmRuntimeLines.filter((line) => !line.includes(expected));
if (stalePnpmLines.length > 0) {
  fail(
    [
      "pnpm-lock.yaml contains runtime-contract tarball(s) that differ from package.json:",
      ...stalePnpmLines.map((line) => `  ${line.trim()}`),
    ].join("\n")
  );
}

console.log(`[runtime-contract] dependency locks match ${expected}`);
