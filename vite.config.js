import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
    root: './ui',
    plugins: [
        viteSingleFile(),
        {
            name: 'emit-viewer-module',
            closeBundle() {
                const html = readFileSync(join('dist', 'viewer.html'), 'utf-8');
                writeFileSync(join('dist', 'viewer.js'), `export default ${JSON.stringify(html)};\n`);
            },
        },
    ],
    build: {
        rollupOptions: {
            input: './ui/viewer.html',
        },
        outDir: '../dist',
        emptyOutDir: false,
    },
});
