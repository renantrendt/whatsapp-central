# Gera ui/tlds.js a partir de build/tlds.txt (lista oficial da IANA).
lines = [l.strip().lower() for l in open('build/tlds.txt') if l.strip() and not l.startswith('#')]
ascii = [t for t in lines if t.isascii() and t.replace('-', '').isalnum()]
header = open('build/tlds.txt').readline().strip()
js = "// Lista oficial de terminações de domínio (IANA), para transformar \"site.com.br\" em link.\n// " + header.lstrip('# ') + "\n// Para atualizar: curl -s https://data.iana.org/TLD/tlds-alpha-by-domain.txt -o build/tlds.txt e rodar build/make-tlds.py\n"
js += "const TLDS = new Set('" + ' '.join(ascii) + "'.split(' '))\n"
open('ui/tlds.js', 'w').write(js)
