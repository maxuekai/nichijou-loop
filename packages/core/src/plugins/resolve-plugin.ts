import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 将 `pkg@1.2.3` 规范为 `pkg`；路径与 file: 原样返回 */
export function normalizePluginSpec(spec: string): string {
  const s = spec.trim();
  if (!s || s.startsWith("file:") || s.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(s) || s.startsWith(".")) {
    return s;
  }
  const lastAt = s.lastIndexOf("@");
  if (lastAt <= 0) return s;
  const rest = s.slice(lastAt + 1);
  if (/^\d|^[vV]?\d+\.\d/.test(rest)) {
    return s.slice(0, lastAt);
  }
  return s;
}

/** 将 config.plugins 中的一项解析为可 `import()` 的 file URL */
export function resolvePluginImportUrl(spec: string, pluginsDir: string): string {
  const trimmed = spec.trim();
  if (!trimmed) throw new Error("empty plugin spec");

  if (trimmed.startsWith("file:")) {
    let fsPath: string;
    try {
      fsPath = fileURLToPath(trimmed);
    } catch {
      throw new Error(`无效的 file URL: ${trimmed}`);
    }
    if (!existsSync(fsPath)) throw new Error(`path not found: ${fsPath}`);
    if (statSync(fsPath).isDirectory()) {
      return entryUrlFromPackageRoot(fsPath);
    }
    return pathToFileURL(fsPath).href;
  }

  if (trimmed.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(trimmed)) {
    if (!existsSync(trimmed)) throw new Error(`path not found: ${trimmed}`);
    if (statSync(trimmed).isDirectory()) {
      return entryUrlFromPackageRoot(trimmed);
    }
    return pathToFileURL(trimmed).href;
  }

  if (trimmed.startsWith(".")) {
    const full = join(pluginsDir, trimmed);
    if (!existsSync(full)) throw new Error(`path not found: ${full}`);
    if (statSync(full).isDirectory()) {
      return entryUrlFromPackageRoot(full);
    }
    return pathToFileURL(full).href;
  }

  const pkgName = normalizePluginSpec(trimmed);
  const pkgDir = join(pluginsDir, "node_modules", pkgName);
  const pkgJsonPath = join(pkgDir, "package.json");
  if (!existsSync(pkgJsonPath)) {
    throw new Error(
      `插件未安装: ${pkgName}（在 ~/.nichijou/plugins 执行 nichijou plugin install ${pkgName}）`,
    );
  }
  return entryUrlFromPackageRoot(pkgDir);
}

function entryUrlFromPackageRoot(pkgDir: string): string {
  const pkgJsonPath = join(pkgDir, "package.json");
  if (!existsSync(pkgJsonPath)) {
    throw new Error(`目录下无 package.json: ${pkgDir}`);
  }
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as {
    exports?: Record<string, { import?: string } | string>;
    main?: string;
  };
  let entry = "dist/index.js";
  const exp = pkg.exports?.["."];
  if (typeof exp === "string") entry = exp;
  else if (exp && typeof exp === "object" && "import" in exp && exp.import) entry = exp.import as string;
  else if (pkg.main) entry = pkg.main;
  const fullPath = join(pkgDir, entry);
  if (!existsSync(fullPath)) throw new Error(`入口不存在: ${fullPath}`);
  return pathToFileURL(fullPath).href;
}
