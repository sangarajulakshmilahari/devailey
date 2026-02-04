const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

// Copy media folder
function copyMediaFolder() {
  const mediaSource = path.join(__dirname, 'media');
  const mediaTarget = path.join(__dirname, 'dist', 'media');
  
  // Check if source media folder exists
  if (!fs.existsSync(mediaSource)) {
    console.warn('⚠️  Warning: media folder not found, skipping copy');
    return;
  }
  
  // Create target directory
  if (!fs.existsSync(mediaTarget)) {
    fs.mkdirSync(mediaTarget, { recursive: true });
  }
  
  // Copy files
  const files = fs.readdirSync(mediaSource);
  files.forEach(file => {
    const sourcePath = path.join(mediaSource, file);
    const targetPath = path.join(mediaTarget, file);
    
    // Only copy files, not directories
    if (fs.statSync(sourcePath).isFile()) {
      fs.copyFileSync(sourcePath, targetPath);
      console.log(`  ✓ Copied ${file}`);
    }
  });
  
  console.log('✅ Media folder copied to dist/media');
}

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/extension.js',
    external: [
      'vscode',
      'onnxruntime-node',
      '@xenova/transformers',
      'sharp'
    ],
    logLevel: 'info',
    plugins: [
      {
        name: 'native-node-modules',
        setup(build) {
          build.onResolve({ filter: /\.node$/ }, args => ({
            path: args.path,
            external: true,
          }));
        },
      },
      esbuildProblemMatcherPlugin,
      // Add copy media plugin
      {
        name: 'copy-media',
        setup(build) {
          build.onEnd(() => {
            try {
              copyMediaFolder();
            } catch (error) {
              console.error('❌ Failed to copy media:', error.message);
            }
          });
        }
      }
    ],
  });

  if (watch) {
    await ctx.watch();
    console.log('👀 [watch] watching for changes...');
    process.stdin.resume();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
    console.log('✅ [build] complete');
  }
}

const esbuildProblemMatcherPlugin = {
  name: 'esbuild-problem-matcher',
  setup(build) {
    build.onStart(() => {
      console.log('🔨 [watch] build started');
    });
    build.onEnd(result => {
      if (result.errors.length > 0) {
        result.errors.forEach(({ text, location }) => {
          console.error(`✘ [ERROR] ${text}`);
          if (location) {
            console.error(`    ${location.file}:${location.line}:${location.column}:`);
          }
        });
      } else {
        console.log('✅ [watch] build finished');
      }
    });
  },
};

main().catch(e => {
  console.error(e);
  process.exit(1);
});