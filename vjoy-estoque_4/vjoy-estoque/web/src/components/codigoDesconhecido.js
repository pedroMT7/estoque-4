// Quando o leitor entrega um código que não está na base:
// - na ENTRADA, qualquer operador pode cadastrar como produto novo (o código fica registrado e a entrada segue);
// - quem tem permissão de cadastro também pode ligar o código a um produto que já existe.
import { post } from '../api.js';

export async function tratarCodigoDesconhecido({ dialog, pode, codigo, permitirNovo = false }) {
  const cod = String(codigo).trim().toUpperCase();
  const podeNovo = permitirNovo && (pode('entrada') || pode('cadastros'));
  const podeVincular = pode('cadastros');
  if (!podeNovo && !podeVincular) return false;
  const escolha = await dialog({
    titulo: 'Código fora da base', tom: 'alerta',
    mensagem: `O leitor leu "${cod}", que não está na base de produtos.` + (podeNovo ? ' Você pode cadastrar como produto novo e seguir com a entrada.' : ''),
    confirmar: podeNovo ? 'Cadastrar produto novo' : null,
    campo: podeNovo ? { rotulo: 'Descrição (opcional — pode completar depois em Produtos)', minimo: 0 } : undefined,
    extras: podeVincular ? [{ valor: 'vincular', texto: 'É um produto que já existe', classe: 'btn-secundario' }] : [],
    cancelar: 'Agora não',
  });
  if (!escolha) return false;
  if (escolha === 'vincular') return !!(await dialog({ tipo: 'vincular', codigo: cod }));
  await post('/produtos/rapido', { codigo: cod, descricao: escolha.texto });
  return true;
}
export const dicaSemPermissao = (codigo) => `Código lido: ${codigo}. Ele não está na base — peça à gestão para cadastrar ou vincular em Produtos → Códigos não reconhecidos.`;
