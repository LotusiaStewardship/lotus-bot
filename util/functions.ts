/**
 * Async generator to iterate over a collection in chunks
 * @param collection - The collection to iterate over
 * @param chunkSize - The size of each chunk
 * @returns An async generator that yields chunks of the collection
 */
export async function* asyncCollection<T>(collection: T[]): AsyncIterable<T> {
  for (let i = 0; i < collection.length; i++) {
    yield collection[i]
  }
}
