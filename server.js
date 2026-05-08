// Carrega variáveis de ambiente (Railway e desenvolvimento local)
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const { v4: uuid } = require('uuid');
const Database = require('better-sqlite3');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ───────────────────────────────────────────────
// PASTAS BÁSICAS
// ───────────────────────────────────────────────
['data', 'uploads', 'propostas', 'public'].forEach((dir) => {
  fs.mkdirSync(path.join(__dirname, dir), { recursive: true });
});

// ───────────────────────────────────────────────
// BANCO DE DADOS (SQLite com better-sqlite3)
// ───────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'data/sistema.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS clientes (
    id TEXT PRIMARY KEY,
    nome TEXT NOT NULL,
    telefone TEXT,
    email TEXT,
    cpf_cnpj TEXT,
    endereco TEXT,
    cidade TEXT,
    tipo TEXT DEFAULT 'pessoa_fisica',
    observacoes TEXT,
    criado_em TEXT NOT NULL,
    ativo INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS orcamentos (
    id TEXT PRIMARY KEY,
    numero INTEGER,
    cliente_nome TEXT,
    cliente_telefone TEXT,
    cliente_email TEXT,
    status TEXT DEFAULT 'rascunho',
    pdf_cliente TEXT,
    foto_projeto TEXT,
    itens TEXT,
    custo_material REAL DEFAULT 0,
    custo_pintura REAL DEFAULT 0,
    custo_mao_obra REAL DEFAULT 0,
    custo_total REAL DEFAULT 0,
    valor_venda REAL DEFAULT 0,
    valor_avista REAL DEFAULT 0,
    valor_parcela REAL DEFAULT 0,
    observacoes TEXT,
    pdf_proposta TEXT,
    criado_em TEXT NOT NULL,
    atualizado_em TEXT
  );

  CREATE TABLE IF NOT EXISTS sequencias (
    chave TEXT PRIMARY KEY,
    valor INTEGER DEFAULT 0
  );
  INSERT OR IGNORE INTO sequencias (chave, valor)
  VALUES ('orcamento', 0);
`);

function proximoNumeroOrcamento() {
  db.prepare(UPDATE sequencias SET valor = valor + 1 WHERE chave = 'orcamento').run();
  const row = db.prepare(SELECT valor FROM sequencias WHERE chave = 'orcamento').get();
  return row.valor;
}

// ───────────────────────────────────────────────
// CONFIGURAÇÃO DE CÁLCULO
// ───────────────────────────────────────────────
const CFG = {
  mult: parseFloat(process.env.MULTIPLICADOR_VENDA) || 2.5,
  pintBasica: parseFloat(process.env.PRECO_PINTURA_BASICA) || 100,
  pintEspecial: parseFloat(process.env.PRECO_PINTURA_ESPECIAL) || 150,
  descAvista: parseFloat(process.env.DESCONTO_AVISTA) || 0.10,
  parcelas: parseInt(process.env.MAX_PARCELAS, 10) || 10
};

function areaM2(largura_cm, altura_cm) {
  return (largura_cm / 100) * (altura_cm / 100);
}

function custoPintura(largura_cm, altura_cm, tipo) {
  if (!tipo || tipo === 'sem_pintura') return 0;
  const base = tipo === 'especial' ? CFG.pintEspecial : CFG.pintBasica;
  return areaM2(largura_cm, altura_cm) * base;
}

function calcularOrcamento(itens = []) {
  let totalMat = 0;
  let totalPint = 0;
  let totalMO = 0;

  const itensCalculados = itens.map((item) => {
    const qtd = item.quantidade || 1;
    const largura = item.largura_cm || 0;
    const altura = item.altura_cm || 0;

    const area = areaM2(largura, altura);
    const matUnit = item.custo_material_unitario || 0;
    const pintUnit = custoPintura(largura, altura, item.tipo_pintura);
    const moUnit = item.mao_obra_unitaria || 0;

    const matItem = matUnit * qtd;
    const pintItem = pintUnit * qtd;
    const moItem = moUnit * qtd;

    const custoUnit = matUnit + pintUnit + moUnit;
    const custoTotalItem = custoUnit * qtd;
    const vendaItem = custoTotalItem * CFG.mult;

    totalMat += matItem;
    totalPint += pintItem;
    totalMO += moItem;

    return {
      ...item,
      area_m2: parseFloat(area.toFixed(4)),
      custo_material_item: parseFloat(matItem.toFixed(2)),
      custo_pintura_unitario: parseFloat(pintUnit.toFixed(2)),
      custo_pintura_item: parseFloat(pintItem.toFixed(2)),
      custo_mao_obra_item: parseFloat(moItem.toFixed(2)),
      custo_unitario: parseFloat(custoUnit.toFixed(2)),
      custo_total_item: parseFloat(custoTotalItem.toFixed(2)),
      valor_venda_item: parseFloat(vendaItem.toFixed(2))
    };
  });

  const custoTotal = totalMat + totalPint + totalMO;
  const valorVenda = custoTotal * CFG.mult;

  return {
    itens: itensCalculados,
    custo_material: parseFloat(totalMat.toFixed(2)),
    custo_pintura: parseFloat(totalPint.toFixed(2)),
    custo_mao_obra: parseFloat(totalMO.toFixed(2)),
    custo_total: parseFloat(custoTotal.toFixed(2)),
    valor_venda: parseFloat(valorVenda.toFixed(2)),
    valor_avista: parseFloat((valorVenda * (1 - CFG.descAvista)).toFixed(2)),
    valor_parcela: parseFloat((valorVenda / CFG.parcelas).toFixed(2)),
    max_parcelas: CFG.parcelas,
    multiplicador: CFG.mult
  };
}

// ───────────────────────────────────────────────
// IA – GEMINI
// ───────────────────────────────────────────────
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

async function extrairDadosPDF(texto) {
  // Se não tiver chave, devolve estrutura vazia e deixa o usuário preencher
  if (!process.env.GEMINI_API_KEY) {
    return {
      cliente: { nome: null, telefone: null, email: null },
      itens: [],
      observacoes_gerais: null,
      confianca: 'baixa'
    };
  }

  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });

  const prompt = `
Você é especialista em orçamentos de serralheria artística.
Analise o texto abaixo de um PDF de orçamento e retorne APENAS um JSON válido.

TEXTO DO PDF:
${texto}

FORMATO EXATO:
{
  "cliente": {
    "nome": "",
    "telefone": "",
    "email": ""
  },
  "itens": [{
    "descricao": "",
    "largura_cm": 0,
    "altura_cm": 0,
    "quantidade": 1,
    "material": "",
    "custo_material_unitario": 0,
    "tipo_pintura": "basica",
    "mao_obra_unitaria": 0,
    "observacoes": null
  }],
  "observacoes_gerais": "",
  "confianca": "baixa|media|alta"
}
`;

  const result = await model.generateContent(prompt);
  const responseText = result.response.text().trim()
    .replace(/json\n?/g, '')
    .replace(/\n?/g, '')
    .trim();

  return JSON.parse(responseText);
}

// ───────────────────────────────────────────────
// EXPRESS / API
// ───────────────────────────────────────────────
const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  limits: { fileSize: 50 * 1024 * 1024 }
});

const agoraISO = () => new Date().toISOString();

// ROTAS DE CLIENTES (bem simples)
app.get('/api/clientes', (req, res) => {
  const clientes = db.prepare(`
    SELECT * FROM clientes
    WHERE ativo = 1
    ORDER BY nome
  `).all();
  res.json(clientes);
});

app.post('/api/clientes', (req, res) => {
  const id = uuid();
  const c = {
    id,
    nome: req.body.nome,
    telefone: req.body.telefone || null,
    email: req.body.email || null,
    cpf_cnpj: req.body.cpf_cnpj || null,
    endereco: req.body.endereco || null,
    cidade: req.body.cidade || null,
    tipo: req.body.tipo || 'pessoa_fisica',
    observacoes: req.body.observacoes || null,
    criado_em: agoraISO()
  };

  db.prepare(`
    INSERT INTO clientes
    (id, nome, telefone, email, cpf_cnpj, endereco, cidade, tipo, observacoes, criado_em)
    VALUES
    (@id, @nome, @telefone, @email, @cpf_cnpj, @endereco, @cidade, @tipo, @observacoes, @criado_em)
  `).run(c);

  res.status(201).json({ id });
});

// UPLOAD DO PDF + IA + CÁLCULO
app.post('/api/orcamentos/upload', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ erro: 'Arquivo PDF obrigatório.' });
    }

    const pdfPath = req.file.path;
    const buffer = fs.readFileSync(pdfPath);
    const parsed = await pdfParse(buffer);

    let dadosIA;
    try {
      dadosIA = await extrairDadosPDF(parsed.text);
    } catch (erroIA) {
      console.error('Erro ao chamar IA:', erroIA);
      dadosIA = {
        cliente: { nome: null, telefone: null, email: null },
        itens: [],
        observacoes_gerais: null,
        confianca: 'baixa'
      };
    }

    const calculo = calcularOrcamento(dadosIA.itens || []);
    const id = uuid();
    const numero = proximoNumeroOrcamento();

    db.prepare(`
      INSERT INTO orcamentos (
        id, numero, cliente_nome, cliente_telefone, cliente_email,
        status, pdf_cliente, foto_projeto, itens,
        custo_material, custo_pintura, custo_mao_obra, custo_total,
        valor_venda, valor_avista, valor_parcela,
        observacoes, criado_em
      ) VALUES (
        @id, @numero, @cliente_nome, @cliente_telefone, @cliente_email,
        @status, @pdf_cliente, @foto_projeto, @itens,
        @custo_material, @custo_pintura, @custo_mao_obra, @custo_total,
        @valor_venda, @valor_avista, @valor_parcela,
        @observacoes, @criado_em
      )
    `).run({
      id,
      numero,
      cliente_nome: dadosIA.cliente?.nome || req.body.cliente_nome || null,
      cliente_telefone: dadosIA.cliente?.telefone || req.body.cliente_telefone || null,
      cliente_email: dadosIA.cliente?.email || req.body.cliente_email || null,
      status: 'rascunho',
      pdf_cliente: pdfPath,
      foto_projeto: null,
      itens: JSON.stringify(calculo.itens),
      custo_material: calculo.custo_material,
      custo_pintura: calculo.custo_pintura,
      custo_mao_obra: calculo.custo_mao_obra,
      custo_total: calculo.custo_total,
      valor_venda: calculo.valor_venda,
      valor_avista: calculo.valor_avista,
      valor_parcela: calculo.valor_parcela,
      observacoes: dadosIA.observacoes_gerais || null,
      criado_em: agoraISO()
    });

    res.status(201).json({
      id,
      numero,
      calculo,
      dados_ia: dadosIA
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: err.message });
  }
});

// LISTAR ORÇAMENTOS
app.get('/api/orcamentos', (req, res) => {
  const orcamentos = db.prepare(`
    SELECT * FROM orcamentos
    ORDER BY criado_em DESC
  `).all().map((o) => ({
    ...o,
    itens: JSON.parse(o.itens || '[]')
  }));

  res.json(orcamentos);
});

// FRONTEND – qualquer rota cai no index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(✅ Arte e Ferro v2 rodando na porta ${PORT});
});
