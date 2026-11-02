/**
 * Archivo de bloqueo: impide dos servidores sobre la misma BD y que la CLI
 * restaure una BD mientras el servidor está en ejecución.
 */
import fs from 'node:fs';
import path from 'node:path';

interface ContenidoBloqueo {
  pid: number;
  iniciado_en: string;
}

function procesoVivo(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Devuelve el PID del servidor activo, o null si no hay ninguno (los bloqueos huérfanos se ignoran). */
export function servidorActivo(rutaBloqueo: string): number | null {
  if (!fs.existsSync(rutaBloqueo)) return null;
  try {
    const c = JSON.parse(fs.readFileSync(rutaBloqueo, 'utf8')) as ContenidoBloqueo;
    return c.pid !== process.pid && procesoVivo(c.pid) ? c.pid : null;
  } catch {
    return null;
  }
}

export function adquirirBloqueo(rutaBloqueo: string): () => void {
  const pid = servidorActivo(rutaBloqueo);
  if (pid !== null) throw new Error(`Ya hay un servidor en ejecución sobre estos datos (PID ${pid}).`);
  fs.mkdirSync(path.dirname(rutaBloqueo), { recursive: true });
  const contenido: ContenidoBloqueo = { pid: process.pid, iniciado_en: new Date().toISOString() };
  fs.writeFileSync(rutaBloqueo, JSON.stringify(contenido), 'utf8');
  return () => {
    try {
      const c = JSON.parse(fs.readFileSync(rutaBloqueo, 'utf8')) as ContenidoBloqueo;
      if (c.pid === process.pid) fs.rmSync(rutaBloqueo, { force: true });
    } catch {
      /* ya no existe */
    }
  };
}
