# Append a section to README.md before "## Where things are".
#   python tools/note.py <file-with-markdown>
import io, sys
add = io.open(sys.argv[1], encoding='utf8').read().strip() + '\n\n'
s = io.open('README.md', encoding='utf8').read()
assert '## Where things are' in s
io.open('README.md', 'w', encoding='utf8', newline='\n').write(s.replace('## Where things are', add + '## Where things are', 1))
