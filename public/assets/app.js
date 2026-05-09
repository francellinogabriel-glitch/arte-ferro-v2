const apiBase = '';

async function carregarOrcamentos() {
  const container = document.getElementById('lista-orcamentos');
  container.textContent = 'Carregando...';

  try {
    const resp = await fetch(${apiBase}/api/orcamentos);
    const dados = await resp.json();

    if (!dados || !dados.length) {
      container.textContent = 'Nenhum orçamento encontrado ainda.';
      return;
    }

    const linhas = dados.map(o => {
      return `
        <tr>
          <td>${o.numero}</td>
          <td>${o.cliente_nome || '-'}</td>
          <td>R$ ${o.valor_venda?.toFixed(2)}</td>
          <td>${new Date(o.criado_em).toLocaleString('pt-BR')}</td>
        </tr>
      `;
    }).join('');

    container.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Nº</th>
            <th>Cliente</th>
            <th>Valor venda</th>
            <th>Criado em</th>
          </tr>
        </thead>
        <tbody>${linhas}</tbody>
      </table>
    `;
  } catch (err) {
    console.error(err);
    container.textContent = 'Erro ao carregar orçamentos.';
  }
}

async function enviarPDF(e) {
  e.preventDefault();

  async function enviarPDF(e) {
  e.preventDefault();

  const inputPdf = document.getElementById('pdf');
  const inputImgs = document.getElementById('imagens');
  const resultado = document.getElementById('upload-resultado');

  if (!inputPdf.files.length) {
    alert('Selecione um PDF antes de enviar.');
    return;
  }

  const formData = new FormData();
  formData.append('pdf', inputPdf.files[0]);

  // adiciona as imagens, se houver
  if (inputImgs.files && inputImgs.files.length) {
    for (const file of inputImgs.files) {
      formData.append('imagens', file);
    }
  }

  resultado.textContent = 'Enviando e processando... (pode levar alguns segundos)';

  try {
    const resp = await fetch(${apiBase}/api/orcamentos/upload, {
      method: 'POST',
      body: formData
    });
    …

  const formData = new FormData();
  formData.append('pdf', input.files[0]);

  resultado.textContent = 'Enviando e processando... (pode levar alguns segundos)';

  try {
    const resp = await fetch(${apiBase}/api/orcamentos/upload, {
      method: 'POST',
      body: formData
    });

    if (!resp.ok) {
      const erro = await resp.json().catch(() => ({}));
      throw new Error(erro.erro || 'Falha ao processar PDF');
    }

    const dados = await resp.json();
    resultado.innerHTML = `
      <p>Orçamento criado com sucesso.</p>
      <p><strong>Número:</strong> ${dados.numero}</p>
      <p><strong>Valor venda:</strong> R$ ${dados.calculo?.valor_venda?.toFixed(2) || '-'}</p>
    `;

    carregarOrcamentos();
  } catch (err) {
    console.error(err);
    resultado.textContent = 'Erro: ' + err.message;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('upload-form');
  form.addEventListener('submit', enviarPDF);

  const btn = document.getElementById('btn-atualizar');
  btn.addEventListener('click', carregarOrcamentos);

  carregarOrcamentos();
});
