module.exports = {
  forbidden: [
    ...["conductor", "reference-planning", "run-contract"].map((moduleName) => ({
      name: `no-${moduleName}-reaching-inside-another-module`,
      comment: "Import another module through its index.ts interface, never its implementation.",
      severity: "error",
      from: { path: `^modules/${moduleName}/` },
      to: {
        path: `^modules/(?!${moduleName}/)[^/]+/(?!index\\.ts$).+`,
      },
    })),
    {
      name: "no-import-from-vendored",
      comment: "repos/ is read-only source reference; import the package from node_modules.",
      severity: "error",
      from: { path: "^modules/" },
      to: { path: "^repos/" },
    },
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules|^repos/" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
  },
}
