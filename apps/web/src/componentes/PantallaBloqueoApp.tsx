import React, { useState } from 'react';
import { verificarCodigoBloqueoLocal } from '@mis-cuentas/core';

interface Props {
  verificador: { saltHex: string; hashHex: string; iteraciones: number };
  onDesbloquear: () => void;
}

export const PantallaBloqueoApp: React.FC<Props> = ({ verificador, onDesbloquear }) => {
  const [codigo, setCodigo] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [verificando, setVerificando] = useState<boolean>(false);

  return (
    <main
      style={{
        minHeight: '100dvh',
        background: '#0f172a',
        color: '#f8fafc',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
      }}
      aria-label="Pantalla de bloqueo de seguridad"
    >
      <section
        className="card"
        style={{
          maxWidth: '400px',
          width: '100%',
          background: '#1e293b',
          borderColor: '#334155',
          color: '#f8fafc',
        }}
      >
        <div className="card-title" style={{ color: '#f8fafc' }}>
          <span>🔒 Mis Cuentas — Aplicación Bloqueada</span>
        </div>
        <p style={{ marginTop: 0, fontSize: '0.86rem', color: '#cbd5e1' }}>
          Introduce tu PIN o contraseña de protección local para visualizar tus registros financieros.
        </p>

        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setVerificando(true);
            setError(null);
            try {
              const ok = await verificarCodigoBloqueoLocal(codigo, verificador);
              if (ok) {
                setCodigo('');
                onDesbloquear();
              } else {
                setError('Código de desbloqueo incorrecto.');
              }
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setVerificando(false);
            }
          }}
        >
          <div className="campo-form">
            <label htmlFor="pin-desbloqueo" style={{ color: '#cbd5e1' }}>
              PIN o Contraseña Local
            </label>
            <input
              id="pin-desbloqueo"
              type="password"
              autoFocus
              className="input-control"
              placeholder="••••"
              value={codigo}
              onChange={(e) => setCodigo(e.target.value)}
              required
            />
          </div>

          {error && (
            <div className="aviso-insuficiente" style={{ marginBottom: '12px' }} role="alert">
              {error}
            </div>
          )}

          <button
            type="submit"
            className="btn btn-primario"
            style={{ width: '100%' }}
            disabled={verificando}
          >
            {verificando ? 'Verificando PBKDF2...' : 'Desbloquear Mis Cuentas'}
          </button>
        </form>
      </section>
    </main>
  );
};
