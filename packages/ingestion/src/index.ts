export { cloneOrFetch, isBareRepo, getHeadCommit, diffFiles, getFileContent, parseNameStatus, parseRevisionRange, getChangedFilesInRange, getCommitHistory } from "./git.js";
export type { GitOptions, RevisionRange, CommitFileChange } from "./git.js";

export { detectChanges, classifyFile, classifyFiles } from "./changeset.js";
export type { ChangeDetectionOptions } from "./changeset.js";
