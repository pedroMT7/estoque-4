// Versão de teste: o pdfkit de navegador precisa registrar as fontes padrão usadas no romaneio.
import PDFDocument, { registerStdFonts } from '../../../node_modules/pdfkit/js/pdfkit.browser.mjs';
import Helvetica from 'pdfkit/standard-fonts/Helvetica';
import HelveticaBold from 'pdfkit/standard-fonts/HelveticaBold';
registerStdFonts(Helvetica, HelveticaBold);
export default PDFDocument;
