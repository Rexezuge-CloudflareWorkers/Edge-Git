async function ftsOrLike<T>(fts: () => Promise<T[]>, like: () => Promise<T[]>, isMissingSchema: (error: unknown) => boolean): Promise<T[]> {
  try {
    return await fts();
  } catch (error) {
    if (!isMissingSchema(error)) {
      try {
        return await like();
      } catch (likeError) {
        if (isMissingSchema(likeError)) return [];
        throw likeError;
      }
    }
    try {
      return await like();
    } catch (likeError) {
      if (isMissingSchema(likeError)) return [];
      throw likeError;
    }
  }
}

export { ftsOrLike };
