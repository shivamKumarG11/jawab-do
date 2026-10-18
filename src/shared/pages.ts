export type Page<T> = {
  entities: readonly T[]
  blockNumber: bigint
  hasNextPage(): boolean
  next(): Promise<Page<T>>
}

export async function collectPages<T>(first: Page<T>) {
  const entities: T[] = [...first.entities]
  let page = first
  while (page.hasNextPage()) {
    page = await page.next()
    entities.push(...page.entities)
  }
  return { entities, blockNumber: first.blockNumber }
}
