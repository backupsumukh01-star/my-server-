const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const roots = ["server.js", "config", "controllers", "middleware", "routes", "services", "storage", "utils", "scripts"];

function collect(target, files = []) {
    const full = path.join(process.cwd(), target);

    if (!fs.existsSync(full)) {
        return files;
    }

    const stats = fs.statSync(full);

    if (stats.isFile() && full.endsWith(".js")) {
        files.push(full);
        return files;
    }

    if (stats.isDirectory()) {
        fs.readdirSync(full).forEach((entry) => {
            collect(path.join(target, entry), files);
        });
    }

    return files;
}

const files = roots.flatMap((root) => collect(root, []));

files.forEach((file) => {
    execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
});

process.stdout.write(`lint ok (${files.length} files)\n`);
