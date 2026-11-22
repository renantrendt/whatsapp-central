// Abre o banco SQLite. No Mac (Node 22 ou mais novo) usa o SQLite que vem com o
// Node. No Android o Node é a versão 18, que não tem esse módulo; lá usamos o
// node-sqlite3-wasm, o mesmo SQLite compilado em WebAssembly, gravando no disco.
export async function openDatabase(file) {
  try {
    const { DatabaseSync } = await import('node:sqlite')
    return new DatabaseSync(file)
  } catch {}
  const { default: wasm } = await import('node-sqlite3-wasm')
  // Esta versão trava o banco com uma pasta "<arquivo>.lock". Se o app foi fechado
  // à força, a pasta fica para trás e a próxima abertura espera para sempre. Só
  // este app usa o banco, então uma trava que já existe ao abrir é sempre velha.
  if (file !== ':memory:') {
    const fs = await import('node:fs')
    fs.rmSync(`${file}.lock`, { recursive: true, force: true })
  }
  const db = new wasm.Database(file)
  // Guarda cada comando preparado para não recompilar o SQL a cada chamada.
  const cache = new Map()
  const stmt = (sql) => {
    let s = cache.get(sql)
    if (!s) {
      s = db.prepare(sql)
      cache.set(sql, s)
    }
    return s
  }
  const values = (a) => (a.length ? a : undefined)
  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => ({
      get: (...a) => stmt(sql).get(values(a)) ?? undefined,
      all: (...a) => stmt(sql).all(values(a)),
      run: (...a) => stmt(sql).run(values(a)),
    }),
  }
}
