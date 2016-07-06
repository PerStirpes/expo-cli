/**
 * @flow
 */

let JsonFile = require('@exponent/json-file');

import 'instapromise';

import targz from 'tar.gz';
import download from 'download';
import existsAsync from 'exists-async';
import fs from 'fs';
import mkdirp from 'mkdirp';
import path from 'path';
import spawnAsync from '@exponent/spawn-async';
import joi from 'joi';

import Api from './Api';
import ErrorCode from './ErrorCode';
import Logger from './Logger';
import NotificationCode from './NotificationCode';
import * as User from './User';
import * as UrlUtils from './UrlUtils';
import UserSettings from './UserSettings';
import XDLError from './XDlError';
import * as ProjectSettings from './ProjectSettings';

export function packageJsonForRoot(root: string) {
  return new JsonFile(path.join(root, 'package.json'));
}

export function expJsonForRoot(root: string) {
  return new JsonFile(path.join(root, 'exp.json'), {json5: true});
}

export async function expConfigForRootAsync(root: string) {
  let pkg, exp;
  try {
    pkg = await packageJsonForRoot(root).readAsync();
    exp = await expJsonForRoot(root).readAsync();
  } catch (e) {
    // exp or pkg missing
  }

  if (!exp && pkg) {
    exp = pkg.exp;
  }

  return exp;
}

export async function determineEntryPointAsync(root: string) {
  let exp = await expConfigForRootAsync(root);
  let pkgJson = packageJsonForRoot(root);
  let pkg = await pkgJson.readAsync();
  let { main } = pkg;

  // NOTE(brentvatne): why do we have entryPoint and main?
  let entryPoint = main || 'index.js';
  if (exp && exp.entryPoint) {
    entryPoint = exp.entryPoint;
  }
  return entryPoint;
}

function _starterAppCacheDirectory() {
  let dotExponentHomeDirectory = UserSettings.dotExponentHomeDirectory();
  let dir = path.join(dotExponentHomeDirectory, 'starter-app-cache');
  mkdirp.sync(dir);
  return dir;
}

async function _downloadStarterAppAsync(name) {
  let versions = await Api.versionsAsync();
  let starterAppVersion = versions.starterApps[name].version;
  let filename = `${name}-${starterAppVersion}.tar.gz`;
  let starterAppPath = path.join(_starterAppCacheDirectory(), filename);

  if (await existsAsync(starterAppPath)) {
    return starterAppPath;
  }

  let url = `https://s3.amazonaws.com/exp-starter-apps/${filename}`;
  await new download().get(url).dest(_starterAppCacheDirectory()).promise.run();
  return starterAppPath;
}

async function _extract(archive, dir) {
  try {
    await spawnAsync('tar', ['-xvf', archive, '-C', dir], {
      stdio: 'inherit',
      cwd: __dirname,
    });
  } catch (e) {
    await targz().extract(archive, dir);
  }
}

export async function createNewExpAsync(selectedDir: string, extraPackageJsonFields: any, opts: any) {
  // Validate
  let schema = joi.object().keys({
    name: joi.string().required(),
  });

  try {
    await joi.promise.validate(opts, schema);
  } catch (e) {
    throw new XDLError(ErrorCode.INVALID_OPTIONS, e.toString());
  }

  let name = opts.name;
  let root = path.join(selectedDir, name);

  let fileExists = true;
  try {
    // If file doesn't exist it will throw an error.
    // Don't want to continue unless there is nothing there.
    fs.statSync(root);
  } catch (e) {
    fileExists = false;
  }

  if (fileExists) {
    throw new XDLError(ErrorCode.DIRECTORY_ALREADY_EXISTS, `That directory already exists. Please choose a different parent directory or project name. (${root})`);
  }

  // Download files
  await mkdirp.promise(root);

  Logger.notifications.info({code: NotificationCode.PROGRESS}, 'Downloading project files...');
  let starterAppPath = await _downloadStarterAppAsync('default');

  // Extract files
  Logger.notifications.info({code: NotificationCode.PROGRESS}, 'Extracting project files...');
  await _extract(starterAppPath, root);

  // Update files
  Logger.notifications.info({code: NotificationCode.PROGRESS}, 'Customizing project...');

  let author = await UserSettings.getAsync('email', null);
  let packageJsonFile = new JsonFile(path.join(root, 'package.json'));
  let packageJson = await packageJsonFile.readAsync();
  packageJson = Object.assign(packageJson, extraPackageJsonFields);

  let data = Object.assign(packageJson, {
    name,
    version: '0.0.0',
    description: "Hello Exponent!",
    author,
  });

  await packageJsonFile.writeAsync(data);

  // Custom code for replacing __NAME__ in main.js
  let mainJs = await fs.readFile.promise(path.join(root, 'main.js'), 'utf8');
  let customMainJs = mainJs.replace(/__NAME__/g, data.name);
  await fs.writeFile.promise(path.join(root, 'main.js'), customMainJs, 'utf8');

  // Update exp.json
  let expJson = await fs.readFile.promise(path.join(root, 'exp.json'), 'utf8');
  let customExpJson = expJson.replace(/\"My New Project\"/, `"${data.name}"`).replace(/\"my-new-project\"/, `"${data.name}"`);
  await fs.writeFile.promise(path.join(root, 'exp.json'), customExpJson, 'utf8');

  return root;
}

export async function saveRecentExpRootAsync(root: string) {
  root = path.resolve(root);

  // Write the recent Exps JSON file
  let recentExpsJsonFile = UserSettings.recentExpsJsonFile();
  let recentExps = await recentExpsJsonFile.readAsync({cantReadFileDefault: []});
  // Filter out copies of this so we don't get dupes in this list
  recentExps = recentExps.filter(function(x) {
    return x !== root;
  });
  recentExps.unshift(root);
  return await recentExpsJsonFile.writeAsync(recentExps.slice(0, 100));
}

function getHomeDir(): string {
  return process.env[(process.platform === 'win32') ? 'USERPROFILE' : 'HOME'] || '';
}

function makePathReadable(pth) {
  let homedir = getHomeDir();
  if (pth.substr(0, homedir.length) === homedir) {
    return `~${pth.substr(homedir.length)}`;
  } else {
    return pth;
  }
}

export async function expInfoAsync(root: string) {
  let pkgJson = packageJsonForRoot(root);

  let name, description, icon;
  try {
    let exp = await expJsonForRoot(root).readAsync();
    name = exp.name;
    description = exp.description;
    icon = exp.iconUrl;
  } catch (err) {
    let pkg = await pkgJson.readAsync();
    name = pkg.name;
    description = pkg.description;
    icon = pkg.exp && pkg.exp.iconUrl;
  }

  return {
    readableRoot: makePathReadable(root),
    root,
    name,
    description,
    icon,
  };
}

export async function expInfoSafeAsync(root: string) {
  try {
    return await expInfoAsync(root);
  } catch (e) {
    return null;
  }
}

type PublishInfo = {
  args: {
    username: string,
    localPackageName: string,
    packageVersion: string,
    remoteUsername: string,
    remotePackageName: string,
    remoteFullPackageName: string,
    ngrokUrl: string,
    sdkVersion: string,
  },
  body: any,
};

// TODO: remove / change, no longer publishInfo, this is just used for signing
export async function getPublishInfoAsync(root: string): Promise<PublishInfo> {
  let username = await User.getUsernameAsync();
  if (!username) {
    throw new Error(`Can't get username!`);
  }
  let pkg: any;
  let exp: any;

  try {
    pkg = await packageJsonForRoot(root).readAsync();
    exp = await expJsonForRoot(root).readAsync();
  } catch (e) {
    // exp or pkg missing
  }

  let name;
  let version;
  // Support legacy package.json with exp
  if (!exp && pkg && pkg.exp) {
    exp = pkg.exp;
    name = pkg.name;
    version = pkg.version;
  } else if (exp && pkg) {
    name = exp.slug;
    version = pkg.version || exp.version;
  }

  if (!exp || !exp.sdkVersion) {
    throw new Error(`exp.sdkVersion is missing from package.json file`);
  }

  if (!name) {
    throw new Error(`Can't get name of package.`);
  }

  if (!version) {
    throw new Error(`Can't get version of package.`);
  }

  let remotePackageName = name;
  let remoteUsername = username;
  let remoteFullPackageName = `@${remoteUsername}/${remotePackageName}`;
  let localPackageName = name;
  let packageVersion = version;
  let sdkVersion = exp.sdkVersion;

  let entryPoint = await determineEntryPointAsync(root);
  let ngrokUrl = await UrlUtils.constructPublishUrlAsync(root, entryPoint);
  return {
    args: {
      username,
      localPackageName,
      packageVersion,
      remoteUsername,
      remotePackageName,
      remoteFullPackageName,
      ngrokUrl,
      sdkVersion,
    },
    body: pkg,
  };
}

export async function recentValidExpsAsync() {
  let recentExpsJsonFile = UserSettings.recentExpsJsonFile();
  let recentExps = await recentExpsJsonFile.readAsync({cantReadFileDefault: []});

  let results = await Promise.all(recentExps.map(expInfoSafeAsync));
  let filteredResults = results.filter(result => result);
  return filteredResults.slice(0, 5);
}

export async function sendAsync(recipient: string, url_: string) {
  let result = await Api.callMethodAsync('send', [recipient, url_]);
  return result;
}

// TODO: figure out where these functions should live
export async function getProjectRandomnessAsync(projectRoot: string) {
  let ps = await ProjectSettings.readAsync(projectRoot);
  let randomness = ps.urlRandomness;
  if (!randomness) {
    randomness = UrlUtils.someRandomness();
    ProjectSettings.setAsync(projectRoot, {'urlRandomness': randomness});
  }
  return randomness;
}

export async function getLoggedOutPlaceholderUsernameAsync() {
  let lpu = await UserSettings.getAsync('loggedOutPlaceholderUsername', null);
  if (!lpu) {
    lpu = UrlUtils.randomIdentifierForLoggedOutUser();
    await UserSettings.setAsync('loggedOutPlaceholderUsername', lpu);
  }
  return lpu;
}