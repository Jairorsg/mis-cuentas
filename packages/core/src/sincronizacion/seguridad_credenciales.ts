/**
 * Fase 5 — Seguridad de Credenciales, Protección de Sesiones y Bloqueo Local.
 *
 * REGLAS INNEGOCIABLES:
 *  1. Ninguna clave secreta (`service_role`, `sb_secret_*`, `SESSION_SECRET`) puede
 *     utilizarse jamás en el cliente web/PWA ni guardarse en `localStorage`.
 *  2. En el cliente solo se admite la clave pública (`publishable` / `anon`),
 *     obligatoriamente protegida por políticas Row Level Security (RLS).
 *  3. Prohibido registrar información financiera personal (montos, descripciones,
 *     saldos, cuentas) o tokens en consola o logs.
 */

export interface ResultadoValidacionCredencialCliente {
  valida: boolean;
  motivoRechazo?: string;
}

/**
 * Verifica que una URL de producción NO apunte a `localhost`, `127.0.0.1`,
 * `0.0.0.0`, `[::1]`, dominios `.local`/`.lan` ni direcciones IP privadas de red local
 * (`192.168.x.x`, `10.x.x.x`, `172.16.x.x` - `172.31.x.x`, `169.254.x.x`),
 * garantizando que el celular funcione con la PC completamente apagada.
 */
export function esEndpointLocalOIpPrivadaProhibida(urlCandidata: string): {
  prohibido: boolean;
  motivo?: string;
} {
  let parsed: URL;
  try {
    parsed = new URL(urlCandidata.trim());
  } catch {
    return {
      prohibido: true,
      motivo: 'La URL configurada no tiene un formato válido.',
    };
  }

  const host = parsed.hostname.toLowerCase();

  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '[::1]' ||
    host.endsWith('.local') ||
    host.endsWith('.lan') ||
    host.endsWith('.internal') ||
    host.endsWith('.home')
  ) {
    return {
      prohibido: true,
      motivo:
        'BLOQUEO DE INDEPENDENCIA CLOUD: Ninguna funcionalidad de producción puede depender de localhost ni de un servidor ejecutado en tu PC.',
    };
  }

  // Bloques IPv4 privados RFC 1918 y link-local RFC 3927
  const matchIpv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (matchIpv4) {
    const a = Number(matchIpv4[1]);
    const b = Number(matchIpv4[2]);
    const esPrivada =
      a === 10 ||
      a === 127 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 169 && b === 254);
    if (esPrivada) {
      return {
        prohibido: true,
        motivo:
          'BLOQUEO DE INDEPENDENCIA CLOUD: No se permite conectar a una IP local/privada de tu red doméstica o PC. El celular debe conectarse directamente a Supabase Cloud.',
      };
    }
  }

  if (parsed.protocol !== 'https:') {
    return {
      prohibido: true,
      motivo:
        'BLOQUEO DE SEGURIDAD CLOUD: La conexión desde Vercel y el celular hacia Supabase debe utilizar obligatoriamente HTTPS.',
    };
  }

  return { prohibido: false };
}

/**
 * Decodifica de forma segura el payload de un JWT (si tiene formato de 3 segmentos base64url)
 * únicamente para inspeccionar el campo `role` y bloquear `service_role` en el frontend.
 */
function extraerRolJwtSinVerificarFirma(token: string): string | null {
  const partes = token.split('.');
  if (partes.length !== 3) return null;
  try {
    const base64 = partes[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const json =
      typeof atob === 'function'
        ? atob(base64)
        : Buffer.from(base64, 'base64').toString('utf8');
    const obj = JSON.parse(json) as { role?: unknown };
    return typeof obj.role === 'string' ? obj.role : null;
  } catch {
    return null;
  }
}

/**
 * Verifica que una clave proporcionada al cliente NO sea una clave secreta de servidor
 * (`service_role` o `sb_secret_...`) y que el endpoint sea 100% cloud e independiente de la PC.
 */
export function validarClavePublicaSupabaseEnCliente(
  urlSupabase: string | null | undefined,
  clavePublica: string | null | undefined,
): ResultadoValidacionCredencialCliente {
  if (!urlSupabase || !urlSupabase.trim()) {
    return { valida: false, motivoRechazo: 'URL de Supabase no configurada.' };
  }
  const urlLimpia = urlSupabase.trim();
  const chequeoLocal = esEndpointLocalOIpPrivadaProhibida(urlLimpia);
  if (chequeoLocal.prohibido) {
    return {
      valida: false,
      motivoRechazo: chequeoLocal.motivo,
    };
  }

  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(urlLimpia)) {
    return {
      valida: false,
      motivoRechazo: 'La URL de Supabase debe corresponder a un proyecto en la nube (https://<proyecto>.supabase.co).',
    };
  }

  if (!clavePublica || !clavePublica.trim()) {
    return { valida: false, motivoRechazo: 'Clave publishable/anon no configurada.' };
  }
  const clave = clavePublica.trim();

  if (
    clave.startsWith('sb_secret_') ||
    clave.toLowerCase().includes('service_role')
  ) {
    return {
      valida: false,
      motivoRechazo:
        'BLOQUEO DE SEGURIDAD: Se detectó una clave secreta (service_role / sb_secret) en el cliente. Las claves secretas deben permanecer exclusivamente en el backend.',
    };
  }

  const rolJwt = extraerRolJwtSinVerificarFirma(clave);
  if (rolJwt === 'service_role' || rolJwt === 'supabase_admin') {
    return {
      valida: false,
      motivoRechazo:
        'BLOQUEO DE SEGURIDAD: El JWT proporcionado tiene rol administrativo (service_role). En el cliente solo se permite el rol anon/publishable con RLS.',
    };
  }

  return { valida: true };
}

export interface ConfiguracionDominioGratuitoVercel {
  valida: boolean;
  esSubdominioGratuitoVercel: boolean;
  esUrlEstableProduccion: boolean;
  origenHttpsEstable: string | null;
  siteUrlSupabase: string | null;
  redirectUrlsSupabase: string[];
  advertenciaEstabilidadPwa: string | null;
  motivoRechazo?: string;
  principioSeguridadZeroTrust: string;
}

export const PRINCIPIO_SEGURIDAD_URL_NO_ES_SECRETO =
  'PRINCIPIO ZERO-TRUST: El subdominio gratuito *.vercel.app es público y JAMÁS se considera un mecanismo de seguridad. Toda la información financiera está protegida exclusivamente por Supabase Auth (correo único del propietario) y políticas Row Level Security (ENABLE + FORCE RLS con auth.uid() = propietario_id) en PostgreSQL.';

/**
 * Valida que la dirección de producción utilice exclusivamente el subdominio gratuito
 * HTTPS proporcionado por Vercel (`https://<proyecto>.vercel.app`), sin requerir
 * compra de dominios ni configuración DNS, y genera las URLs exactas de redirección
 * para configurar en Supabase Auth.
 */
export function validarYConstruirConfiguracionDominioVercel(
  urlCandidata: string,
): ConfiguracionDominioGratuitoVercel {
  const chequeoLocal = esEndpointLocalOIpPrivadaProhibida(urlCandidata);
  if (chequeoLocal.prohibido) {
    return {
      valida: false,
      esSubdominioGratuitoVercel: false,
      esUrlEstableProduccion: false,
      origenHttpsEstable: null,
      siteUrlSupabase: null,
      redirectUrlsSupabase: [],
      advertenciaEstabilidadPwa: null,
      motivoRechazo: chequeoLocal.motivo,
      principioSeguridadZeroTrust: PRINCIPIO_SEGURIDAD_URL_NO_ES_SECRETO,
    };
  }

  const parsed = new URL(urlCandidata.trim());
  const host = parsed.hostname.toLowerCase();

  if (!host.endsWith('.vercel.app') || host === 'vercel.app') {
    return {
      valida: false,
      esSubdominioGratuitoVercel: false,
      esUrlEstableProduccion: false,
      origenHttpsEstable: null,
      siteUrlSupabase: null,
      redirectUrlsSupabase: [],
      advertenciaEstabilidadPwa: null,
      motivoRechazo:
        'RESTRICCIÓN DE DOMINIO: Debe utilizarse exclusivamente el subdominio gratuito HTTPS proporcionado por Vercel (https://<tu-proyecto>.vercel.app), sin dominios externos ni DNS.',
      principioSeguridadZeroTrust: PRINCIPIO_SEGURIDAD_URL_NO_ES_SECRETO,
    };
  }

  const subdominio = host.slice(0, -'.vercel.app'.length);
  if (!/^[a-z0-9-]+$/.test(subdominio) || subdominio.startsWith('-') || subdominio.endsWith('-')) {
    return {
      valida: false,
      esSubdominioGratuitoVercel: false,
      esUrlEstableProduccion: false,
      origenHttpsEstable: null,
      siteUrlSupabase: null,
      redirectUrlsSupabase: [],
      advertenciaEstabilidadPwa: null,
      motivoRechazo: 'El subdominio *.vercel.app contiene caracteres inválidos.',
      principioSeguridadZeroTrust: PRINCIPIO_SEGURIDAD_URL_NO_ES_SECRETO,
    };
  }

  // Detectar si es una URL efímera de preview de Vercel (p. ej. `proyecto-git-main-usuario.vercel.app`
  // o `proyecto-8f9a1b2c3-usuario.vercel.app`) en lugar del alias estable de producción (`proyecto.vercel.app`).
  const parecePreviewEfimero =
    subdominio.includes('-git-') || /-[a-z0-9]{9,}-[a-z0-9-]+$/.test(subdominio);

  const origenHttpsEstable = `https://${host}`;

  return {
    valida: true,
    esSubdominioGratuitoVercel: true,
    esUrlEstableProduccion: !parecePreviewEfimero,
    origenHttpsEstable,
    siteUrlSupabase: origenHttpsEstable,
    redirectUrlsSupabase: [
      `${origenHttpsEstable}/`,
      `${origenHttpsEstable}/auth/callback`,
      `${origenHttpsEstable}/sincronizacion`,
      `${origenHttpsEstable}/**`,
    ],
    advertenciaEstabilidadPwa: parecePreviewEfimero
      ? 'Atención: Esta dirección parece una URL temporal de vista previa (Preview Deployment) de Vercel. Para instalar la PWA en Android/iPhone y conservar IndexedDB en una dirección permanente, utiliza el subdominio principal estable de producción (https://<tu-proyecto>.vercel.app).'
      : null,
    principioSeguridadZeroTrust: PRINCIPIO_SEGURIDAD_URL_NO_ES_SECRETO,
  };
}

/**
 * Redacta cualquier campo financiero o credencial de un objeto antes de emitir
 * diagnósticos técnicos, garantizando que jamás se registren montos, saldos,
 * descripciones ni tokens en logs.
 */
export function sanitizarParaLogSinDatosFinancieros(
  evento: Record<string, unknown>,
): Record<string, unknown> {
  const CAMPOS_PROHIBIDOS = new Set([
    'monto',
    'montocentimos',
    'monto_centimos',
    'saldo',
    'saldocentimos',
    'presupuesto',
    'presupuestocentimos',
    'descripcion',
    'concepto',
    'notas',
    'datos',
    'carga',
    'password',
    'contrasena',
    'token',
    'accesstoken',
    'access_token',
    'refreshtoken',
    'refresh_token',
    'apikey',
    'anonkey',
    'service_role',
  ]);

  const salida: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(evento)) {
    if (CAMPOS_PROHIBIDOS.has(k.toLowerCase())) {
      salida[k] = '[REDACTADO_POR_PRIVACIDAD]';
    } else if (typeof v === 'object' && v !== null) {
      salida[k] = '[OBJETO_OMITIDO_EN_LOG]';
    } else {
      salida[k] = v;
    }
  }
  return salida;
}

function bytesAHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexABytes(hex: string): Uint8Array {
  const limpio = hex.trim();
  const out = new Uint8Array(limpio.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(limpio.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Genera un hash verificador PBKDF2-HMAC-SHA256 para la pantalla de bloqueo local
 * de la aplicación sin almacenar jamás el PIN o contraseña en texto plano.
 */
export async function crearVerificadorBloqueoLocal(
  pinOContrasena: string,
  iteraciones = 120_000,
): Promise<{ saltHex: string; hashHex: string; iteraciones: number }> {
  const limpio = pinOContrasena.trim();
  if (limpio.length < 4) {
    throw new Error('El código de bloqueo debe tener al menos 4 caracteres.');
  }
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const enc = new TextEncoder();
  const materialClave = await crypto.subtle.importKey(
    'raw',
    enc.encode(limpio),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt as unknown as BufferSource,
      iterations: iteraciones,
      hash: 'SHA-256',
    },
    materialClave,
    256,
  );
  return {
    saltHex: bytesAHex(salt),
    hashHex: bytesAHex(new Uint8Array(bits)),
    iteraciones,
  };
}

/**
 * Verifica en tiempo constante si el PIN o contraseña introducido coincide con el verificador PBKDF2.
 */
export async function verificarCodigoBloqueoLocal(
  pinOContrasena: string,
  verificador: { saltHex: string; hashHex: string; iteraciones: number },
): Promise<boolean> {
  const salt = hexABytes(verificador.saltHex);
  const enc = new TextEncoder();
  const materialClave = await crypto.subtle.importKey(
    'raw',
    enc.encode(pinOContrasena.trim()),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt as unknown as BufferSource,
      iterations: verificador.iteraciones,
      hash: 'SHA-256',
    },
    materialClave,
    256,
  );
  const candidatoHex = bytesAHex(new Uint8Array(bits));
  if (candidatoHex.length !== verificador.hashHex.length) return false;
  let diff = 0;
  for (let i = 0; i < candidatoHex.length; i++) {
    diff |= candidatoHex.charCodeAt(i) ^ verificador.hashHex.charCodeAt(i);
  }
  return diff === 0;
}
