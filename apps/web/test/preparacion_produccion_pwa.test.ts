/**
 * Suite de Verificación de Preparación para Publicación en Producción
 * (Vercel + Supabase Cloud + GitHub Privado + Instalación PWA en Android e iPhone).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  esEndpointLocalOIpPrivadaProhibida,
  evaluarPoliticaCachePwa,
  RECURSOS_SHELL_PRECACHE,
  validarClavePublicaSupabaseEnCliente,
  validarYConstruirConfiguracionDominioVercel,
} from '@mis-cuentas/core';
import { resolverVistaDesdeUbicacion } from '../src/App';
import { ClienteSupabasePrivado } from '../src/persistencia/cliente_supabase';

const dirActual = path.dirname(fileURLToPath(import.meta.url));
const raizRepo = path.resolve(dirActual, '../../..');
const dirPublic = path.resolve(dirActual, '../public');

function leerDimensionesPng(rutaPng: string): { ancho: number; alto: number; esPngValido: boolean } {
  const buf = fs.readFileSync(rutaPng);
  const firmaPng = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const esPngValido = buf.subarray(0, 8).equals(firmaPng) && buf.subarray(12, 16).toString('ascii') === 'IHDR';
  const ancho = buf.readUInt32BE(16);
  const alto = buf.readUInt32BE(20);
  return { ancho, alto, esPngValido };
}

describe('Preparación para Producción (Vercel + Supabase + PWA Android e iOS)', () => {
  it('1. Valida manifest.webmanifest, display standalone, start_url y dimensiones reales de iconos PNG/SVG (192x192, 512x512 y 180x180 iOS)', () => {
    const rutaWebmanifest = path.join(dirPublic, 'manifest.webmanifest');
    const rutaManifestJson = path.join(dirPublic, 'manifest.json');
    expect(fs.existsSync(rutaWebmanifest)).toBe(true);
    expect(fs.existsSync(rutaManifestJson)).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(rutaWebmanifest, 'utf8')) as {
      name: string;
      short_name: string;
      start_url: string;
      scope: string;
      display: string;
      icons: { src: string; sizes: string; type: string; purpose?: string }[];
    };

    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.short_name).toBe('Mis Cuentas');

    // Verificar iconos PNG y SVG de 192x192 y 512x512 en el manifiesto
    const tienePng192 = manifest.icons.some(
      (i) => i.src === '/icono-192.png' && i.sizes === '192x192' && i.type === 'image/png',
    );
    const tienePng512 = manifest.icons.some(
      (i) => i.src === '/icono-512.png' && i.sizes === '512x512' && i.type === 'image/png',
    );
    const tieneSvg192 = manifest.icons.some(
      (i) => i.src === '/icono-192.svg' && i.sizes === '192x192' && i.type === 'image/svg+xml',
    );
    const tieneSvg512 = manifest.icons.some(
      (i) => i.src === '/icono-512.svg' && i.sizes === '512x512' && i.type === 'image/svg+xml',
    );
    expect(tienePng192).toBe(true);
    expect(tienePng512).toBe(true);
    expect(tieneSvg192).toBe(true);
    expect(tieneSvg512).toBe(true);

    // Verificar dimensiones binarias reales en cabecera IHDR de los PNG para Android WebAPK e iPhone SpringBoard
    const dim192 = leerDimensionesPng(path.join(dirPublic, 'icono-192.png'));
    expect(dim192).toEqual({ ancho: 192, alto: 192, esPngValido: true });

    const dim512 = leerDimensionesPng(path.join(dirPublic, 'icono-512.png'));
    expect(dim512).toEqual({ ancho: 512, alto: 512, esPngValido: true });

    const dimApple180 = leerDimensionesPng(path.join(dirPublic, 'apple-touch-icon.png'));
    expect(dimApple180).toEqual({ ancho: 180, alto: 180, esPngValido: true });

    // Verificar index.html para Android e iPhone (Safari standalone + apple-touch-icon PNG + manifest.webmanifest)
    const html = fs.readFileSync(path.resolve(dirActual, '../index.html'), 'utf8');
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(html).toContain('rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png"');
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
    expect(html).toContain('name="mobile-web-app-capable" content="yes"');
  });

  it('2. Verifica Service Worker, estrategia de caché offline-first, vercel.json (HTTPS/HSTS) y rutas SPA al actualizar la página', () => {
    expect(RECURSOS_SHELL_PRECACHE).toContain('/manifest.webmanifest');
    expect(RECURSOS_SHELL_PRECACHE).toContain('/icono-192.png');
    expect(RECURSOS_SHELL_PRECACHE).toContain('/icono-512.png');
    expect(RECURSOS_SHELL_PRECACHE).toContain('/apple-touch-icon.png');

    const evalWebmanifest = evaluarPoliticaCachePwa({
      metodo: 'GET',
      url: 'https://mis-cuentas.vercel.app/manifest.webmanifest',
      origenActual: 'https://mis-cuentas.vercel.app',
    });
    expect(evalWebmanifest.permitirCache).toBe(true);
    expect(evalWebmanifest.estrategia).toBe('CACHE_FIRST_ESTATICO');

    // Verificar vercel.json
    const vercelConfig = JSON.parse(
      fs.readFileSync(path.join(raizRepo, 'vercel.json'), 'utf8'),
    ) as {
      buildCommand: string;
      outputDirectory: string;
      headers: { source: string; headers: { key: string; value: string }[] }[];
      rewrites: { source: string; destination: string }[];
    };

    expect(vercelConfig.buildCommand).toBe('npm run build:web');
    expect(vercelConfig.outputDirectory).toBe('apps/web/dist');

    // Cabecera HTTPS Strict-Transport-Security (HSTS)
    const cabecerasGlobales = vercelConfig.headers.find((h) => h.source === '/(.*)')?.headers ?? [];
    const hsts = cabecerasGlobales.find((h) => h.key === 'Strict-Transport-Security');
    expect(hsts?.value).toContain('max-age=63072000');

    // Resolución de rutas SPA al actualizar la página
    expect(resolverVistaDesdeUbicacion('/')).toBe('dashboard');
    expect(resolverVistaDesdeUbicacion('/movimientos')).toBe('movimientos');
    expect(resolverVistaDesdeUbicacion('/eventos')).toBe('eventos');
    expect(resolverVistaDesdeUbicacion('/analitica')).toBe('analitica');
    expect(resolverVistaDesdeUbicacion('/predicciones')).toBe('predicciones');
    expect(resolverVistaDesdeUbicacion('/sincronizacion')).toBe('sincronizacion');
    expect(resolverVistaDesdeUbicacion('/auth/callback')).toBe('sincronizacion');
  });

  it('3. Comprueba variables de entorno, protección contra exposición de claves secretas y políticas RLS en migración SQL', () => {
    const envExample = fs.readFileSync(path.join(raizRepo, '.env.example'), 'utf8');
    expect(envExample).toContain('VITE_SUPABASE_URL=');
    expect(envExample).toContain('VITE_SUPABASE_PUBLISHABLE_KEY=');
    expect(envExample).toContain('VITE_PROPIETARIO_EMAIL_AUTORIZADO=');
    expect(envExample).not.toContain('VITE_SUPABASE_SERVICE_ROLE_KEY');

    const gitignore = fs.readFileSync(path.join(raizRepo, '.gitignore'), 'utf8');
    expect(gitignore).toContain('.env');
    expect(gitignore).toContain('!.env.example');
    expect(gitignore).toContain('data/');

    // Bloqueo de HTTP sin cifrar y de claves service_role en cliente
    expect(esEndpointLocalOIpPrivadaProhibida('http://proyecto.supabase.co').prohibido).toBe(true);
    expect(
      validarClavePublicaSupabaseEnCliente(
        'https://proyecto.supabase.co',
        'sb_secret_clave_prohibida_en_frontend',
      ).valida,
    ).toBe(false);

    // Verificar que las 9 tablas en la migración de Supabase tengan ENABLE + FORCE ROW LEVEL SECURITY
    const sqlRls = fs.readFileSync(
      path.join(raizRepo, 'supabase/migrations/20260401000001_esquema_rls_multidispositivo.sql'),
      'utf8',
    );
    const matchesEnable = sqlRls.match(/enable row level security/gi) ?? [];
    const matchesForce = sqlRls.match(/force row level security/gi) ?? [];
    expect(matchesEnable.length).toBe(9);
    expect(matchesForce.length).toBe(9);
  });

  it('4. Comprueba el manejo de redirecciones de autenticación de Supabase Auth (#access_token=...) y el bloqueo de correos no autorizados', async () => {
    const cliente = new ClienteSupabasePrivado({
      url: 'https://mi-boveda-personal.supabase.co',
      publishableKey: 'sb_publishable_test_key_produccion',
      emailPropietarioAutorizado: 'propietario@miscuentas.pe',
    });

    // Construimos un JWT de retorno simulado para el propietario autorizado
    const payloadAutorizado = Buffer.from(
      JSON.stringify({ sub: 'uid-prop-real', email: 'propietario@miscuentas.pe', role: 'authenticated' }),
    ).toString('base64url');
    const tokenAutorizado = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${payloadAutorizado}.firma`;

    const sesion = await cliente.procesarRetornoRedireccionAuth(
      `https://mis-cuentas.vercel.app/auth/callback#access_token=${tokenAutorizado}&refresh_token=ref-123&expires_in=3600&token_type=bearer`,
    );
    expect(sesion).not.toBeNull();
    expect(sesion?.uid).toBe('uid-prop-real');
    expect(sesion?.email).toBe('propietario@miscuentas.pe');
    expect(sesion?.refreshToken).toBe('ref-123');

    // Si un tercero intenta autenticarse mediante redirección con otro correo, se rechaza inmediatamente
    const payloadIntruso = Buffer.from(
      JSON.stringify({ sub: 'uid-intruso', email: 'intruso@otro.com', role: 'authenticated' }),
    ).toString('base64url');
    const tokenIntruso = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${payloadIntruso}.firma`;

    await expect(
      cliente.procesarRetornoRedireccionAuth(
        `https://mis-cuentas.vercel.app/auth/callback#access_token=${tokenIntruso}&refresh_token=ref-999&expires_in=3600`,
      ),
    ).rejects.toThrow(/ACCESO_DENEGADO/);

    // 5. Restricción exclusiva al subdominio gratuito *.vercel.app y URLs de redirección de Supabase Auth
    const cfgEstable = validarYConstruirConfiguracionDominioVercel('https://mis-cuentas-personales.vercel.app');
    expect(cfgEstable.valida).toBe(true);
    expect(cfgEstable.esSubdominioGratuitoVercel).toBe(true);
    expect(cfgEstable.esUrlEstableProduccion).toBe(true);
    expect(cfgEstable.siteUrlSupabase).toBe('https://mis-cuentas-personales.vercel.app');
    expect(cfgEstable.redirectUrlsSupabase).toEqual([
      'https://mis-cuentas-personales.vercel.app/',
      'https://mis-cuentas-personales.vercel.app/auth/callback',
      'https://mis-cuentas-personales.vercel.app/sincronizacion',
      'https://mis-cuentas-personales.vercel.app/**',
    ]);
    expect(cfgEstable.advertenciaEstabilidadPwa).toBeNull();
    expect(cfgEstable.principioSeguridadZeroTrust).toContain('ZERO-TRUST');

    // Advierte si se abre una URL temporal de preview en lugar del subdominio estable *.vercel.app
    const cfgPreview = validarYConstruirConfiguracionDominioVercel(
      'https://mis-cuentas-git-main-usuario.vercel.app',
    );
    expect(cfgPreview.valida).toBe(true);
    expect(cfgPreview.esUrlEstableProduccion).toBe(false);
    expect(cfgPreview.advertenciaEstabilidadPwa).toContain('Preview Deployment');

    // Rechaza dominios externos comprados o redirecciones fuera de *.vercel.app
    const cfgDominioExterno = validarYConstruirConfiguracionDominioVercel('https://midominio-comprado.com');
    expect(cfgDominioExterno.valida).toBe(false);
    await expect(
      cliente.procesarRetornoRedireccionAuth(
        `https://sitio-externo.com/auth/callback#access_token=${tokenAutorizado}`,
      ),
    ).rejects.toThrow(/vercel\.app/i);
  });
});
