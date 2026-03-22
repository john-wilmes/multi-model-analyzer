export { cloneOrFetch, isBareRepo, getHeadCommit, diffFiles, getFileContent, getFileContentBatch, parseNameStatus, parseRevisionRange, getChangedFilesInRange, getCommitHistory } from "./git.js";
export type { GitOptions, RevisionRange, CommitFileChange } from "./git.js";

export { detectChanges, classifyFile, classifyFiles } from "./changeset.js";
export type { ChangeDetectionOptions } from "./changeset.js";

export { scanGitHubOrg, scanLocalDirectory } from "./org-scanner.js";
export type { DiscoveredRepo, OrgScanOptions, OrgScanResult } from "./org-scanner.js";

export { scanRepoPackages, buildPackageMap, findRepoDependencies } from "./package-scan.js";
export type { PackageInfo, RepoPackages, PackageMap } from "./package-scan.js";
