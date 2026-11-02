/**
 * Fase 5 — Exportación/Importación JSON Cifrada (Web Crypto AES-256-GCM + PBKDF2)
 * y Transferencia de Pequeños Paquetes Cifrados por QR.
 *
 * REGLAS GARANTIZADAS:
 *  1. Utiliza exclusivamente Web Crypto estándar (`crypto.subtle`) con:
 *     - Derivación de clave: PBKDF2-HMAC-SHA256 (210,000 iteraciones por defecto, sal aleatoria de 16 bytes).
 *     - Cifrado autenticado: AES-256-GCM (IV aleatorio de 12 bytes + tag de autenticación de 128 bits).
 *     - Suma de verificación: SHA-256 del texto plano antes de cifrar.
 *  2. Documenta explícitamente las limitaciones del cifrado local sin servidor de custodia:
 *     si el usuario olvida la contraseña de un respaldo `.enc.json`, es matemáticamente
 *     imposible recuperar el contenido sin la contraseña.
 *  3. Prohibido transferir toda la base financiera en un único QR gigante:
 *     los códigos QR se restringen a emparejamiento o micro-lotes cifrados de hasta
 *     5 movimientos (`MAX_MOVIMIENTOS_POR_PAQUETE_QR = 5` y `MAX_BYTES_QR = 1200`).
 */
import { ahoraISO } from '../fechas';
import type { MovimientoFinanciero } from '../libro';

export const ITERACIONES_PBKDF2_RESPALDO = 210_000;
export const MAX_MOVIMIENTOS_POR_PAQUETE_QR = 5;
export const MAX_BYTES_PAYLOAD_QR = 1800;

export const LIMITACIONES_CIFRADO_WEB_CRYPTO =
  'Cifrado de conocimiento cero con Web Crypto (PBKDF2-HMAC-SHA256 + AES-256-GCM). La contraseña nunca se almacena ni se envía a ningún servidor; si olvida la contraseña del archivo cifrado, no existe llave maestra para descifrarlo. Conserve su contraseña en un gestor seguro.';

export interface SobreRespaldoCifradoJson {
  formato: 'MIS_CUENTAS_ENCRYPTED_BACKUP_V1';
  algoritmo: 'AES-256-GCM';
  kdf: 'PBKDF2-HMAC-SHA256';
  iteracionesKdf: number;
  creadoEn: string;
  saltBase64: string;
  ivBase64: string;
  ciphertextBase64: string;
  sha256PlaintextHex: string;
  advertenciaRecuperacion: string;
}

export interface PaqueteQrCifradoCorto {
  formato: 'MIS_CUENTAS_QR_PACKET_V1';
  tipoPaquete: 'EMPAREJAMIENTO_DISPOSITIVO' | 'MICRO_LOTE_MOVIMIENTOS';
  cantidadMovimientos: number;
  sobreCifrado: SobreRespaldoCifradoJson;
}

function bytesABase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]!);
  }
  return btoa(bin);
}

function base64ABytes(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

function bytesAHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function calcularSha256Hex(bytes: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return bytesAHex(new Uint8Array(hashBuffer));
}

async function derivarClaveAesGcm(
  contrasena: string,
  salt: Uint8Array,
  iteraciones: number,
): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(contrasena),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as unknown as BufferSource,
      iterations: iteraciones,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Cifra cualquier objeto de respaldo financiero en formato JSON autenticado con AES-256-GCM.
 */
export async function exportarJsonCifradoConContrasena(
  datosRespaldo: unknown,
  contrasena: string,
  iteraciones = ITERACIONES_PBKDF2_RESPALDO,
): Promise<string> {
  if (!contrasena || contrasena.trim().length < 6) {
    throw new Error('La contraseña de cifrado debe tener al menos 6 caracteres.');
  }

  const textoPlano = JSON.stringify(datosRespaldo);
  const bytesPlanos = new TextEncoder().encode(textoPlano);
  const sha256PlaintextHex = await calcularSha256Hex(bytesPlanos);

  const salt = new Uint8Array(16);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(salt);
  crypto.getRandomValues(iv);

  const clave = await derivarClaveAesGcm(contrasena, salt, iteraciones);
  const cifradoBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    clave,
    bytesPlanos as unknown as BufferSource,
  );

  const sobre: SobreRespaldoCifradoJson = {
    formato: 'MIS_CUENTAS_ENCRYPTED_BACKUP_V1',
    algoritmo: 'AES-256-GCM',
    kdf: 'PBKDF2-HMAC-SHA256',
    iteracionesKdf: iteraciones,
    creadoEn: ahoraISO(),
    saltBase64: bytesABase64(salt),
    ivBase64: bytesABase64(iv),
    ciphertextBase64: bytesABase64(new Uint8Array(cifradoBuffer)),
    sha256PlaintextHex,
    advertenciaRecuperacion: LIMITACIONES_CIFRADO_WEB_CRYPTO,
  };

  return JSON.stringify(sobre, null, 2);
}

/**
 * Descifra y verifica la autenticidad e integridad SHA-256 de un respaldo JSON cifrado.
 */
export async function importarJsonCifradoConContrasena<T = unknown>(
  contenidoJsonCifrado: string,
  contrasena: string,
): Promise<T> {
  if (!contrasena || !contrasena.trim()) {
    throw new Error('Debe proporcionar la contraseña para descifrar el respaldo.');
  }

  let sobre: SobreRespaldoCifradoJson;
  try {
    sobre = JSON.parse(contenidoJsonCifrado) as SobreRespaldoCifradoJson;
  } catch {
    throw new Error('El archivo no es un JSON válido.');
  }

  if (
    sobre.formato !== 'MIS_CUENTAS_ENCRYPTED_BACKUP_V1' ||
    sobre.algoritmo !== 'AES-256-GCM' ||
    !sobre.saltBase64 ||
    !sobre.ivBase64 ||
    !sobre.ciphertextBase64
  ) {
    throw new Error('Estructura de respaldo cifrado no reconocida o incompleta.');
  }

  const salt = base64ABytes(sobre.saltBase64);
  const iv = base64ABytes(sobre.ivBase64);
  const ciphertext = base64ABytes(sobre.ciphertextBase64);
  const iteraciones =
    typeof sobre.iteracionesKdf === 'number' && sobre.iteracionesKdf >= 10_000
      ? sobre.iteracionesKdf
      : ITERACIONES_PBKDF2_RESPALDO;

  const clave = await derivarClaveAesGcm(contrasena, salt, iteraciones);

  let descifradoBuffer: ArrayBuffer;
  try {
    descifradoBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource },
      clave,
      ciphertext as unknown as BufferSource,
    );
  } catch {
    throw new Error(
      'Contraseña incorrecta o archivo alterado (falló la verificación de autenticidad AES-256-GCM).',
    );
  }

  const bytesPlanos = new Uint8Array(descifradoBuffer);
  const hashVerificado = await calcularSha256Hex(bytesPlanos);
  if (sobre.sha256PlaintextHex && hashVerificado !== sobre.sha256PlaintextHex) {
    throw new Error(
      'El hash de integridad SHA-256 no coincide con el respaldo original.',
    );
  }

  const textoPlano = new TextDecoder().decode(bytesPlanos);
  return JSON.parse(textoPlano) as T;
}

/**
 * Construye un paquete corto cifrado apto para código QR (emparejamiento o hasta 5 movimientos recientes).
 * Rechaza explícitamente cualquier intento de volcar toda la base de datos en un QR gigante.
 */
export async function generarPaqueteQrCifrado(params: {
  tipoPaquete: 'EMPAREJAMIENTO_DISPOSITIVO' | 'MICRO_LOTE_MOVIMIENTOS';
  contrasena: string;
  emparejamiento?: {
    dispositivoOrigenId: string;
    supabaseUrl: string | null;
    propietarioHint: string | null;
  };
  movimientos?: readonly MovimientoFinanciero[];
}): Promise<string> {
  const movs = params.movimientos ?? [];
  if (movs.length > MAX_MOVIMIENTOS_POR_PAQUETE_QR) {
    throw new Error(
      `PROHIBIDO_QR_GIGANTE: Un código QR solo admite hasta ${MAX_MOVIMIENTOS_POR_PAQUETE_QR} movimientos recientes (se intentaron incluir ${movs.length}). Para transferir toda la base financiera utilice la Exportación JSON Cifrada o la Sincronización Cloud con Supabase.`,
    );
  }

  // Compactar cada movimiento para que el paquete cifrado quepa cómodamente en un QR estándar
  const cargaCompacta =
    params.tipoPaquete === 'EMPAREJAMIENTO_DISPOSITIVO'
      ? {
          t: 'PAIR',
          d: params.emparejamiento?.dispositivoOrigenId ?? 'pc',
          u: params.emparejamiento?.supabaseUrl ?? null,
          p: params.emparejamiento?.propietarioHint ?? null,
        }
      : {
          t: 'MOVS',
          m: movs.map((m) => ({
            id: m.id,
            f: m.fechaMovimiento,
            h: m.horaMovimiento,
            tp: m.tipo,
            cat: m.categoriaId,
            cta: m.cuentaId,
            ctad: m.cuentaDestinoId,
            mc: m.montoCentimos,
            ev: m.eventoId,
            et: m.etiquetas,
            ds: m.descripcion ? m.descripcion.slice(0, 40) : null,
          })),
        };

  const sobreStr = await exportarJsonCifradoConContrasena(cargaCompacta, params.contrasena, 50_000);
  const sobreObj = JSON.parse(sobreStr) as SobreRespaldoCifradoJson;

  const paquete: PaqueteQrCifradoCorto = {
    formato: 'MIS_CUENTAS_QR_PACKET_V1',
    tipoPaquete: params.tipoPaquete,
    cantidadMovimientos: movs.length,
    sobreCifrado: sobreObj,
  };

  const serializado = JSON.stringify(paquete);
  if (serializado.length > MAX_BYTES_PAYLOAD_QR) {
    throw new Error(
      `PROHIBIDO_QR_GIGANTE: El paquete cifrado resultante (${serializado.length} bytes) supera el límite seguro de ${MAX_BYTES_PAYLOAD_QR} bytes para lectura óptica por cámara. Reduzca el número de movimientos o use un archivo .enc.json.`,
    );
  }

  return serializado;
}

/**
 * Descifra un paquete corto leído desde un código QR.
 */
export async function abrirPaqueteQrCifrado(
  cadenaQr: string,
  contrasena: string,
): Promise<{
  tipoPaquete: PaqueteQrCifradoCorto['tipoPaquete'];
  cantidadMovimientos: number;
  datosDescifrados: unknown;
}> {
  const paquete = JSON.parse(cadenaQr) as PaqueteQrCifradoCorto;
  if (paquete.formato !== 'MIS_CUENTAS_QR_PACKET_V1' || !paquete.sobreCifrado) {
    throw new Error('El código QR no contiene un paquete válido de Mis Cuentas.');
  }
  const datosDescifrados = await importarJsonCifradoConContrasena(
    JSON.stringify(paquete.sobreCifrado),
    contrasena,
  );
  return {
    tipoPaquete: paquete.tipoPaquete,
    cantidadMovimientos: paquete.cantidadMovimientos,
    datosDescifrados,
  };
}
