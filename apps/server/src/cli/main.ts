/**
 * CLI de administración del sistema financiero.
 *
 * Comandos soportados:
 *  - inicializar                              : crea/migra la BD y verifica integridad
 *  - crear-usuario --usuario=<nombre> --contrasena=<clave>
 *  - cambiar-contrasena --contrasena=<clave>
 *  - backup                                   : crea un backup manual verificado
 *  - listar-backups                           : lista los backups disponibles
 *  - restaurar --archivo=<ruta_o_nombre>      : restaura desde un backup (con resguardo previo)
 *  - verificar                                : ejecuta el verificador de integridad financiera
 *  - exportar                                 : exporta toda la BD a JSON con SHA-256
 */
import path from 'node:path';
import { cambiarContrasena, crearUsuario, obtenerUsuario } from '../auth/usuario';
import { cargarConfig } from '../config';
import { inicializarBaseDatos } from '../db/inicializacion';
import { crearBackup, listarBackups } from '../sistema/backups';
import { estadoDatos } from '../sistema/estado';
import { exportarAArchivo } from '../sistema/exportacion';
import { verificarIntegridad } from '../sistema/integridad';
import { restaurarBackup } from '../sistema/restauracion';

function leerOpcion(argv: readonly string[], nombre: string): string | undefined {
  const prefijo = `--${nombre}=`;
  const encontrado = argv.find((a) => a.startsWith(prefijo));
  return encontrado ? encontrado.slice(prefijo.length) : undefined;
}

async function ejecutar(): Promise<void> {
  const args = process.argv.slice(2);
  const comando = args.find((a) => !a.startsWith('--'));
  const cfg = cargarConfig(process.argv, process.env);

  switch (comando) {
    case 'inicializar': {
      const { db, version, migracionesAplicadas } = await inicializarBaseDatos({
        ruta: cfg.rutaBaseDatos,
        entorno: cfg.entorno,
        directorioBackups: cfg.directorioBackups,
      });
      try {
        const estado = estadoDatos(db);
        const integridad = verificarIntegridad(db);
        console.log(
          JSON.stringify(
            {
              ok: integridad.ok,
              ruta: cfg.rutaBaseDatos,
              entorno: cfg.entorno,
              version_esquema: version,
              migraciones_aplicadas: migracionesAplicadas,
              vacia: estado.vacia,
              usuario_configurado: estado.usuario_configurado,
            },
            null,
            2,
          ),
        );
        if (!integridad.ok) process.exitCode = 1;
      } finally {
        db.close();
      }
      break;
    }

    case 'crear-usuario': {
      const nombre = leerOpcion(args, 'usuario') ?? process.env.MC_USUARIO;
      const contrasena = leerOpcion(args, 'contrasena') ?? process.env.MC_CONTRASENA;
      if (!nombre || !contrasena) {
        throw new Error('Uso: npm run crear-usuario -- --usuario=<nombre> --contrasena=<clave de 12+ caracteres>');
      }
      const { db } = await inicializarBaseDatos({
        ruta: cfg.rutaBaseDatos,
        entorno: cfg.entorno,
        directorioBackups: cfg.directorioBackups,
      });
      try {
        await crearUsuario(db, nombre, contrasena);
        console.log(JSON.stringify({ ok: true, usuario: obtenerUsuario(db)?.nombre }, null, 2));
      } finally {
        db.close();
      }
      break;
    }

    case 'cambiar-contrasena': {
      const contrasena = leerOpcion(args, 'contrasena') ?? process.env.MC_CONTRASENA;
      if (!contrasena) {
        throw new Error('Uso: tsx apps/server/src/cli/main.ts cambiar-contrasena --contrasena=<clave de 12+ caracteres>');
      }
      const { db } = await inicializarBaseDatos({
        ruta: cfg.rutaBaseDatos,
        entorno: cfg.entorno,
        directorioBackups: cfg.directorioBackups,
      });
      try {
        await cambiarContrasena(db, contrasena);
        console.log(JSON.stringify({ ok: true, mensaje: 'Contraseña actualizada y sesiones cerradas' }, null, 2));
      } finally {
        db.close();
      }
      break;
    }

    case 'backup': {
      const { db } = await inicializarBaseDatos({
        ruta: cfg.rutaBaseDatos,
        entorno: cfg.entorno,
        directorioBackups: cfg.directorioBackups,
      });
      try {
        const info = await crearBackup(db, { directorio: cfg.directorioBackups, motivo: 'manual' });
        console.log(JSON.stringify(info, null, 2));
      } finally {
        db.close();
      }
      break;
    }

    case 'listar-backups': {
      const lista = listarBackups(cfg.directorioBackups);
      console.log(JSON.stringify({ total: lista.length, backups: lista }, null, 2));
      break;
    }

    case 'restaurar': {
      const archivo = leerOpcion(args, 'archivo');
      if (!archivo) {
        throw new Error('Uso: npm run restaurar -- --archivo=<ruta o nombre en directorio de backups>');
      }
      const rutaBackup = path.isAbsolute(archivo) ? archivo : path.join(cfg.directorioBackups, archivo);
      const res = await restaurarBackup({
        rutaBackup,
        rutaBaseDatos: cfg.rutaBaseDatos,
        directorioBackups: cfg.directorioBackups,
        rutaBloqueo: cfg.rutaBloqueo,
        entorno: cfg.entorno,
      });
      console.log(JSON.stringify(res, null, 2));
      if (!res.integridad.ok) process.exitCode = 1;
      break;
    }

    case 'verificar': {
      const { db } = await inicializarBaseDatos({
        ruta: cfg.rutaBaseDatos,
        entorno: cfg.entorno,
        directorioBackups: cfg.directorioBackups,
      });
      try {
        const estado = estadoDatos(db);
        const integridad = verificarIntegridad(db);
        console.log(JSON.stringify({ estado, integridad }, null, 2));
        if (!integridad.ok) process.exitCode = 1;
      } finally {
        db.close();
      }
      break;
    }

    case 'exportar': {
      const { db } = await inicializarBaseDatos({
        ruta: cfg.rutaBaseDatos,
        entorno: cfg.entorno,
        directorioBackups: cfg.directorioBackups,
      });
      try {
        const res = exportarAArchivo(db, cfg.directorioExportaciones);
        console.log(JSON.stringify(res, null, 2));
      } finally {
        db.close();
      }
      break;
    }

    default:
      throw new Error(
        `Comando desconocido: "${comando ?? ''}". Comandos válidos: inicializar, crear-usuario, cambiar-contrasena, backup, listar-backups, restaurar, verificar, exportar`,
      );
  }
}

ejecutar().catch((err) => {
  console.error('[cli] Error:', (err as Error).message);
  process.exit(1);
});
