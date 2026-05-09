require('dotenv').config();
var express = require('express');
var cors = require('cors');
var path = require('path');
var fs = require('fs');
var multer = require('multer');
var pdfParse = require('pdf-parse');
var uuidv4 = require('uuid').v4;
var Database = require('better-sqlite3');
var GoogleGenerativeAI = require('@google/generative-ai').GoogleGenerativeAI;

['data','uploads','propostas','public'].forEach(function(dir) {
  fs.mkdirSync(path.join(__dirname, dir), { recursive: true });
});

var db = new Database(path.join(__dirname, 'data/sistema.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(
  'CREATE TABLE IF NOT EXISTS orcamentos (' +
  '  id TEXT PRIMARY KEY,' +
  '  numero INTEGER,' +
  '  cliente_nome
