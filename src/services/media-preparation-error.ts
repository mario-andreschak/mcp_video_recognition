import type { ProviderFailureCategory } from '../types/provider.js';

export interface LocalMediaPreparationFailure {
  category: ProviderFailureCategory;
  safeMessage: string;
  code: string;
}

export const classifyLocalMediaPreparationFailure = (
  cause: unknown
): LocalMediaPreparationFailure | undefined => {
  if (!(cause instanceof Error)) return undefined;

  let filesystemCode: string | undefined;
  try {
    filesystemCode = (cause as NodeJS.ErrnoException).code;
  } catch {
    return undefined;
  }

  if (filesystemCode === 'ENOENT') {
    return {
      category: 'invalid-request',
      safeMessage: 'The media file was not found in the server process.',
      code: 'MEDIA_FILE_NOT_FOUND'
    };
  }
  if (filesystemCode === 'EACCES' || filesystemCode === 'EPERM') {
    return {
      category: 'permission',
      safeMessage: 'The server process cannot read the media file.',
      code: 'MEDIA_FILE_NOT_READABLE'
    };
  }
  if (filesystemCode === 'EISDIR') {
    return {
      category: 'invalid-request',
      safeMessage: 'The media path must point to a regular file.',
      code: 'MEDIA_PATH_NOT_FILE'
    };
  }

  return undefined;
};
