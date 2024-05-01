const { join, basename } = require("path")
const { readFileSync, existsSync, mkdirSync, createWriteStream, readdirSync, lstatSync, rmSync } = require('fs')
const { spawn } = require('child_process')

const esbuild = require('esbuild')
const { copy } = require('esbuild-plugin-copy')

async function execProcess(cmd, logFile, args, buildDir= '.build') {
  console.log('Running from',)
  console.log("Compiling...\n", process.cwd(), args)

  if (!existsSync(join(process.cwd(), buildDir))) {
    mkdirSync(join(process.cwd(), buildDir))
  }

  const compileOut = spawn(cmd, args)

  const stdoutFilePath = `${buildDir}/${logFile}.log`
  const stderrFilePath = `${buildDir}/${logFile}-err.log`


  const outPromise = new Promise((resolve) => {
    if (compileOut.stdout != null) {
      let outPipe = createWriteStream(stdoutFilePath)
      compileOut.stdout.pipe(outPipe)
      compileOut.stdout.on('end', function (data) {
        outPipe.close()
        resolve()
      })
    } else {
      resolve()
    }
  })

  const errPromise = new Promise((resolve) => {
    if (compileOut.stderr != null) {
      let outPipe = createWriteStream(stderrFilePath)
      compileOut.stderr.pipe(outPipe)
      compileOut.stderr.on('end', function (data) {
        outPipe.close()
        resolve()
      })
    } else {
      resolve()
    }
  })

  let editCode = 0
  const closePromise = new Promise(resolve => {
    compileOut.on('close', (code) => {
      editCode = code
      resolve()
    })
    compileOut.on('error', (err) => {
      console.error(err)
      resolve()
    })
  })

  await Promise.all([outPromise, errPromise, closePromise])

  if (editCode !== 0) {
    const data = readFileSync(stdoutFilePath)
    const errData = readFileSync(stderrFilePath)
    console.error('\n' + data.toString() + '\n' + errData.toString())
    process.exit(editCode)
  }
}

let args = process.argv.splice(2)

function collectFiles(source) {
  const result = []
  const files = readdirSync(source)
  for (const f of files) {
    const sourceFile = join(source, f)

    if (lstatSync(sourceFile).isDirectory()) {
      result.push(...collectFiles(sourceFile))
    } else {
      let ext = basename(sourceFile)
      if (!ext.endsWith('.ts') && !ext.endsWith('.js') && !ext.endsWith('.svelte')) {
        continue
      }
      result.push(sourceFile)
    }
  }
  return result
}

switch (args[0]) {
  case 'ui':
    console.log('Nothing to compile for UI');
    break;

  case 'transpile':
    transpileFiles(args[1]);
    break;

  case 'lint':
    lintFiles(args);
    break;

  case 'validate':
    validateTSC();
    break;

  default:
    fullBuild();
    break;
}

async function transpileFiles(directory) {
  let filesToTranspile = collectFiles(join(process.cwd(), directory));
  let startTime = Date.now();
  await performESBuild(filesToTranspile);
  console.log("Transpile time: ", Date.now() - startTime);
}

async function lintFiles(args) {
  let startTime = Date.now();
  await execProcess('eslint', 'lint-output', ['--ext', '.ts,.js,.svelte', '--fix', ...args.slice(1)]);
  console.log("Lint time: ", Date.now() - startTime);
}

async function fullBuild() {
  let startTime = Date.now();
  const filesToTranspile = collectFiles(join(process.cwd(), 'src'));
  await Promise.all([
    performESBuild(filesToTranspile),
    validateTSC()
  ]);
  console.log("Full build time: ", Date.now() - startTime);
}

async function performESBuild(filesToTranspile) {
  await esbuild.build({
    entryPoints: filesToTranspile,
    bundle: false,
    minify: false,
    outdir: 'lib',
    keepNames: true,
    sourcemap: 'inline',
    allowOverwrite: true,
    format: 'cjs',
    plugins: [
      copy({
        resolveFrom: 'cwd',
        assets: {
          from: ['src/**/*.json'],
          to: ['./lib']
        },
        watch: true
      })
    ]
  });
}

async function validateTSC() {
  let startTime = Date.now();
  await execProcess('tsc', 'validate', [
    '-pretty',
    '--emitDeclarationOnly',
    '--incremental',
    '--tsBuildInfoFile', '.validate/tsBuildInfoFile.info'
  ], '.validate');
  console.log("Validate time: ", Date.now() - startTime);
}
