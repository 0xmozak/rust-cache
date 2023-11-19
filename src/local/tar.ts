import * as fs from 'fs/promises'
import * as path from 'path'
import { exec } from '@actions/exec'
import * as io from '@actions/io'
import * as utils from './cacheUtils'
import { ArchiveTool, Exec } from './contracts'
import {
  CompressionMethod,
  SystemTarPathOnWindows,
  ArchiveToolType,
  TarFilename,
} from './constants'

const IS_WINDOWS = process.platform === 'win32' 

// Returns tar path and type: BSD or GNU
const getTarTool = utils.lazyInit<ArchiveTool>(async () => {
  switch (process.platform) {
    case 'win32': {
      const gnuTar = await utils.getGnuTarPathOnWindows()
      const systemTar = SystemTarPathOnWindows
      if (gnuTar) {
        // Use GNUtar as default on windows
        return { path: gnuTar, type: ArchiveToolType.GNU } as ArchiveTool
      } if ((await fs.stat(systemTar)).isFile()) {
        return { path: systemTar, type: ArchiveToolType.BSD } as ArchiveTool
      }
      break
    }
    case 'darwin': {
      const gnuTar = await io.which('gtar', false)
      if (gnuTar) {
        // fix permission denied errors when extracting BSD tar archive with GNU tar - https://github.com/actions/cache/issues/527
        return { path: gnuTar, type: ArchiveToolType.GNU } as ArchiveTool
      }
      return {
        path: await io.which('tar', true),
        type: ArchiveToolType.BSD,
      } as ArchiveTool
    }
    default:
      break
  }
  // Default assumption is GNU tar is present in path
  return {
    path: await io.which('tar', true),
    type: ArchiveToolType.GNU,
  } as ArchiveTool
});

const isBsdTarZstd = utils.lazyInit(async () => {
  const tarPath = await getTarTool()
  const compressionMethod = await utils.getCompressionMethod()

  return tarPath.type === ArchiveToolType.BSD
  && compressionMethod !== CompressionMethod.Gzip
  && IS_WINDOWS
})


export const getCacheFileName = utils.lazyInit(async () => {
  return utils.posixFile(await isBsdTarZstd()
    ? TarFilename
    : await utils.getCacheFileName())
});

async function getTarProgram(
  methodSpecificArgs: () => Promise<string[]>,
): Promise<Exec> {
  const tarPath = await getTarTool()
  const program = tarPath.path
  const args = await methodSpecificArgs()

  // Platform specific args
  if (tarPath.type === ArchiveToolType.GNU) {
    switch (process.platform) {
      case 'win32':
        args.push('--force-local')
        break
      case 'darwin':
        args.push('--delay-directory-restore')
        break
      default:
    }
  }

  return { program, args } as Exec
}


// Return create specific arguments
async function getTarCreateArgs(
  manifestPath: utils.PosixPath,
  archivePath: utils.PosixPath,
) {
  const workingDirectory = utils.posixPath(getWorkingDirectory())

  return [
    '--posix',
    '-cf',
    archivePath,
    '-P',
    '-C',
    workingDirectory,
    '--files-from',
    manifestPath,
  ]
}
async function getTarExtractArgs(
  archivePath: utils.PosixPath,
): Promise<string[]> {
  const workingDirectory = getWorkingDirectory()
  const file = await isBsdTarZstd() ? TarFilename : archivePath;

  return [
    '-xf',
    file,
    '-P',
    '-C',
    utils.posixPath(workingDirectory),
  ]
}
// Return arguments for tar as per tarPath, compressionMethod, method type and os
async function getTarListArgs(
  archivePath: utils.PosixPath,
): Promise<string[]> {
  const file = await isBsdTarZstd() ? TarFilename : utils.posixPath(archivePath)

  return [    
    '-tf',
    file,
    '-P',
  ]
}

// Returns commands to run tar and compression program
async function getCommands(
  addMethodSpecificTarArgs: () => Promise<string[]>,
  getProgram: () => Promise<Exec | string[]>,
  isCreate: boolean = false,
): Promise<Exec[]> {
  const tarProgram = (await getTarProgram(addMethodSpecificTarArgs))
  const compressionProgram = (await getProgram())

  if ("program" in compressionProgram) {
    if (isCreate) {
      return [compressionProgram, tarProgram]
    } else {
      return [tarProgram, compressionProgram]
    }
  }
  return [{
    program: tarProgram.program,
    args: tarProgram.args.concat(compressionProgram)
  }]
}

function getWorkingDirectory(): string {
  return process.env.GITHUB_WORKSPACE ?? process.cwd()
}

// Common function for extractTar and listTar to get the compression method
async function getDecompressionProgram(archivePath: utils.PosixPath): Promise<Exec | string[]> {
  const compressionMethod = await utils.getCompressionMethod()
  // -d: Decompress.
  // unzstd is equivalent to 'zstd -d'
  // --long=#: Enables long distance matching with # bits. Maximum is 30 (1GB) on 32-bit OS and 31 (2GB) on 64-bit.
  // Using 30 here because we also support 32-bit self-hosted runners.
  const BSD_TAR_ZSTD = await isBsdTarZstd()
  switch (compressionMethod) {
    case CompressionMethod.Zstd:
      if (BSD_TAR_ZSTD) {
        return {
          program: 'zstd',
          args: ['-d', '--long=30', '--force', '-o', TarFilename, archivePath],
        }
      }
      if (IS_WINDOWS) {
        return ['--use-compress-program', '"zstd -d --long=30"' ]
      }
      return ['--use-compress-program', 'unzstd', '--long=30']
    case CompressionMethod.ZstdWithoutLong:
      if (BSD_TAR_ZSTD) {
        return {
          program: 'zstd',
          args: ['-d', '--force', '-o', TarFilename, archivePath],
        }
      }
      if (IS_WINDOWS) {
        return ['--use-compress-program', '"zstd -d"' ]
      }
      return ['--use-compress-program', 'unzstd']
    default:
      return Promise.resolve(['-z'])
  }
}

// Used for creating the archive
// -T#: Compress using # working thread. If # is 0, attempt to detect and use the number of physical CPU cores.
// zstdmt is equivalent to 'zstd -T0'
// --long=#: Enables long distance matching with # bits. Maximum is 30 (1GB) on 32-bit OS and 31 (2GB) on 64-bit.
// Using 30 here because we also support 32-bit self-hosted runners.
// Long range mode is added to zstd in v1.3.2 release, so we will not use --long in older version of zstd.
async function getCompressionProgram(archivePath: utils.PosixPath): Promise<Exec | string[]> {
  const compressionMethod = await utils.getCompressionMethod()
  const BSD_TAR_ZSTD = await isBsdTarZstd()
  switch (compressionMethod) {
    case CompressionMethod.Zstd:
      if (BSD_TAR_ZSTD) {
        return {
          program: 'zstd',
          args: ['-T0', '--long=30', '--force', '-o', archivePath, TarFilename]
        }
      }
      if (IS_WINDOWS) {
        return ['--use-compress-program', '"zstd -T0 --long=30"']
      }
      return ['--use-compress-program', 'zstdmt', '--long=30']
    case CompressionMethod.ZstdWithoutLong:
      if (BSD_TAR_ZSTD) {
        return {
          program: 'zstd',
          args: ['-T0', '--force', '-o', archivePath, TarFilename]
        }
      }
      if (IS_WINDOWS) {
        return ['--use-compress-program', '"zstd -T0"']
      }
      return ['--use-compress-program', 'zstdmt']
    default:
      return ['-z']
  }
}

// Executes all commands as separate processes
async function execCommands(commands: Exec[], cwd?: string): Promise<void> {
  // eslint-disable-next-line no-restricted-syntax
  for (const command of commands) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await exec(command.program, command.args, {
        cwd,
        env: { ...(process.env as object), MSYS: 'winsymlinks:nativestrict' },
      })
    } catch (error) {
      throw new Error(
        `${command.program} failed with error: ${(error as Error).message}`,
      )
    }
  }
}

// List the contents of a tar
export async function listTar(
  archivePath: utils.PosixPath,
): Promise<void> {
  const commands = await getCommands(
    () => getTarListArgs(archivePath),
    () => getDecompressionProgram(archivePath),
  )
  await execCommands(commands)
}

// Extract a tar
export async function extractTar(
  archivePath: utils.PosixPath,
): Promise<void> {
  // Create directory to extract tar into
  const workingDirectory = getWorkingDirectory()
  await io.mkdirP(workingDirectory)
  const commands = await getCommands(
    () => getTarExtractArgs(archivePath),
    () => getDecompressionProgram(archivePath),
  )
  await execCommands(commands)
}

// Create a tar
export async function createTar(
  archiveFolder: utils.PosixPath,
  sourceDirectories: string[],
): Promise<void> {
  // Use temp files to avoid multiple writers
  const randomName = utils.randomName();
  const manifestFilename = `manifest.${randomName}.txt`
  const TarTempFileName = utils.posixPath(randomName + await getCacheFileName())
  const ZipTempFileName = utils.posixPath(randomName + await utils.getCacheFileName())
  const ZipFileName = utils.posixPath(await utils.getCacheFileName())

  const manifestPath = path.join(archiveFolder, manifestFilename);
  const TarTempPath = utils.posixJoin(archiveFolder, TarTempFileName)
  const ZipTempPath = utils.posixJoin(archiveFolder, ZipTempFileName)
  const ZipPath = utils.posixJoin(archiveFolder, ZipFileName)

  // Write source directories to manifest.txt to avoid command length limits
  await fs.writeFile(
    manifestPath,
    sourceDirectories.join('\n'),
  )
  const commands = await getCommands(
    () => getTarCreateArgs(utils.posixPath(manifestPath), TarTempPath),
    () => getCompressionProgram(ZipTempPath),
    true,
  )
  await execCommands(commands, archiveFolder)
  
  await fs.link(ZipTempPath, ZipPath)
  await fs.unlink(ZipTempPath)
}
