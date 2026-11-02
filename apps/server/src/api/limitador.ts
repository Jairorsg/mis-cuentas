/** Limitador simple en memoria de intentos fallidos por clave (IP). */
export class LimitadorIntentos {
  private readonly fallos = new Map<string, number[]>();
  private readonly op: { maxIntentos: number; ventanaMs: number };

  constructor(op: { maxIntentos: number; ventanaMs: number }) {
    this.op = op;
  }

  private recientes(clave: string, ahora: number): number[] {
    const lista = (this.fallos.get(clave) ?? []).filter((t) => ahora - t < this.op.ventanaMs);
    if (lista.length) this.fallos.set(clave, lista);
    else this.fallos.delete(clave);
    return lista;
  }

  bloqueado(clave: string, ahora = Date.now()): boolean {
    return this.recientes(clave, ahora).length >= this.op.maxIntentos;
  }

  registrarFallo(clave: string, ahora = Date.now()): void {
    this.fallos.set(clave, [...this.recientes(clave, ahora), ahora]);
  }

  reiniciar(clave: string): void {
    this.fallos.delete(clave);
  }
}
