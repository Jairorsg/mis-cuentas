/**
 * Fase 5 — Estrategia de Caché PWA y Protección de Privacidad en Service Worker.
 *
 * REGLA INNEGOCIABLE:
 *  - Almacenar únicamente los recursos estáticos de la aplicación (App Shell:
 *    HTML, JS, CSS, iconos, manifest.json) para garantizar operación offline.
 *  - JAMÁS almacenar información financiera personal, llamadas a Supabase
 *    (`/rest/v1/*`, `/auth/v1/*`), rutas privadas de la API (`/api/*`) ni
 *    peticiones autenticadas en cachés públicas del navegador (`CacheStorage`).
 */

export const VERSION_CACHE_PWA = 'mis-cuentas-shell-v1';

export const RECURSOS_SHELL_PRECACHE = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/manifest.json',
  '/icono-192.png',
  '/icono-512.png',
  '/apple-touch-icon.png',
  '/icono-192.svg',
  '/icono-512.svg',
] as const;

export interface EntradaEvaluacionCachePwa {
  metodo: string;
  url: string;
  origenActual: string;
  tieneCabeceraAuthorization?: boolean;
}

export interface DecisionCachePwa {
  permitirCache: boolean;
  estrategia: 'NETWORK_ONLY_PRIVADO' | 'CACHE_FIRST_ESTATICO' | 'STALE_WHILE_REVALIDATE_SHELL';
  motivo: string;
}

/**
 * Determina si una petición HTTP puede almacenarse en la caché del Service Worker
 * sin exponer datos financieros personales ni respuestas privadas de la API.
 */
export function evaluarPoliticaCachePwa(
  entrada: EntradaEvaluacionCachePwa,
): DecisionCachePwa {
  const metodo = entrada.metodo.toUpperCase();
  if (metodo !== 'GET') {
    return {
      permitirCache: false,
      estrategia: 'NETWORK_ONLY_PRIVADO',
      motivo: `Método ${metodo} no es cacheable.`,
    };
  }

  if (entrada.tieneCabeceraAuthorization) {
    return {
      permitirCache: false,
      estrategia: 'NETWORK_ONLY_PRIVADO',
      motivo: 'Las peticiones con cabecera Authorization contienen datos privados y jamás se guardan en CacheStorage.',
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(entrada.url, entrada.origenActual);
  } catch {
    return {
      permitirCache: false,
      estrategia: 'NETWORK_ONLY_PRIVADO',
      motivo: 'URL inválida.',
    };
  }

  // Bloquear dominios externos (como *.supabase.co) en la caché pública
  if (parsed.origin !== entrada.origenActual) {
    return {
      permitirCache: false,
      estrategia: 'NETWORK_ONLY_PRIVADO',
      motivo: 'Petición cross-origin (p. ej. Supabase Cloud API) excluida de la caché pública.',
    };
  }

  const ruta = parsed.pathname.toLowerCase();

  // Bloquear rutas de API local, endpoints de autenticación o descargas de respaldos financieros
  if (
    ruta.startsWith('/api/') ||
    ruta === '/api' ||
    ruta.startsWith('/rest/v1') ||
    ruta.startsWith('/auth/v1') ||
    ruta.endsWith('.db') ||
    ruta.endsWith('.sqlite') ||
    ruta.endsWith('.csv') ||
    ruta.endsWith('.enc.json')
  ) {
    return {
      permitirCache: false,
      estrategia: 'NETWORK_ONLY_PRIVADO',
      motivo: 'Ruta de API privada o archivo de datos financieros excluido de CacheStorage.',
    };
  }

  // Archivos estáticos con hash de compilación (JS, CSS, fuentes, iconos SVG/PNG)
  if (
    ruta.startsWith('/assets/') ||
    ruta.endsWith('.js') ||
    ruta.endsWith('.css') ||
    ruta.endsWith('.svg') ||
    ruta.endsWith('.png') ||
    ruta.endsWith('.ico') ||
    ruta.endsWith('.woff2') ||
    ruta === '/manifest.webmanifest' ||
    ruta === '/manifest.json'
  ) {
    return {
      permitirCache: true,
      estrategia: 'CACHE_FIRST_ESTATICO',
      motivo: 'Recurso estático inmutable del App Shell.',
    };
  }

  // Navegación del documento principal (SPA shell)
  if (ruta === '/' || ruta === '/index.html' || !ruta.includes('.')) {
    return {
      permitirCache: true,
      estrategia: 'STALE_WHILE_REVALIDATE_SHELL',
      motivo: 'Documento HTML base del App Shell para apertura offline.',
    };
  }

  return {
    permitirCache: false,
    estrategia: 'NETWORK_ONLY_PRIVADO',
    motivo: 'Recurso no clasificado dentro del App Shell.',
  };
}

/**
 * Filtra la lista de nombres de cachés existentes y devuelve las versiones antiguas
 * que el Service Worker debe eliminar en el evento `activate`.
 */
export function obtenerCachesObsoletasPwa(
  nombresCachesExistentes: readonly string[],
  versionActiva: string = VERSION_CACHE_PWA,
): string[] {
  return nombresCachesExistentes.filter(
    (nombre) =>
      nombre.startsWith('mis-cuentas-shell-') && nombre !== versionActiva,
  );
}
