import { configDefaults, defineConfig } from 'vitest/config';

// Los worktrees de `.worktrees/` son otras ramas del mismo repo: sus tests no
// son los de esta rama y correrlos acá duplica (y mezcla) resultados.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, '.worktrees/**'] }
});
