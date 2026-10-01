/** Erro de regra de negócio -> HTTP 4xx com mensagem para o operador */
export class ErroNegocio extends Error {
  constructor(mensagem, { status = 400, codigo = 'ERRO', dados } = {}) {
    super(mensagem);
    this.status = status;
    this.codigo = codigo;
    this.dados = dados;
  }
}
export const falha = (msg, opts) => { throw new ErroNegocio(msg, opts); };
