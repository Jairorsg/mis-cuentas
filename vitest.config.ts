import { defineConfig } from 'vitest/config';

// Las pruebas SIEMPRE corren con APP_ENV=test. La capa de conexión rechaza
// cualquier base de datos que no sea ':memory:' o un archivo dentro del
// directorio temporal del sistema operativo, por lo que las pruebas nunca
// pueden tocar la base de datos real.
export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts', 'apps/**/test/**/*.test.ts'],
    env: { APP_ENV: 'test' },
    pool: 'forks',
    testTimeout: 20000,
  },
});
