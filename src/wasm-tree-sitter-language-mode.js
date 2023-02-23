const Parser = require('web-tree-sitter');
const ScopeDescriptor = require('./scope-descriptor')
const fs = require('fs');
const { Point, Range } = require('text-buffer');
const { Emitter } = require('event-kit');

const initPromise = Parser.init()
createTree = require("./rb-tree")

const VAR_ID = 257
class WASMTreeSitterLanguageMode {
  constructor(buffer, config, grammar) {
    this.emitter = new Emitter();
    this.lastId = 259
    this.scopeNames = new Map([["variable", VAR_ID]])
    this.scopeIds = new Map([[VAR_ID, "variable"]])
    this.buffer = buffer
    this.config = config
    this.injectionsMarkerLayer = buffer.addMarkerLayer();
    this.newRanges = []
    this.oldNodeTexts = new Set()
    let resolve
    this.ready = new Promise(r => resolve = r)
    this.grammar = grammar

    initPromise.then(() =>
      Parser.Language.load(grammar.grammarPath)
    ).then(lang => {
      this.syntaxQuery = lang.query(grammar.syntaxQuery)
      if(grammar.localsQuery) {
        this.localsQuery = lang.query(grammar.localsQuery)
      }
      this.grammar = grammar
      if(grammar.foldsQuery) {
        this.foldsQuery = lang.query(grammar.foldsQuery)
      }
      this.parser = new Parser()
      this.parser.setLanguage(lang)

      // Force first highlight
      this.tree = this.parser.parse("")
      this.boundaries = createTree(comparePoints)
      const startRange = new Range([0, 0], [0, 0])
      const range = buffer.getRange()
      buffer.emitDidChangeEvent({oldRange: startRange, newRange: range, oldText: ""})
      resolve(true)
      global.mode = this
    })

    this.rootScopeDescriptor = new ScopeDescriptor({
      scopes: [grammar.scopeName]
    });
  }

  getGrammar() {
    return this.grammar
  }

  updateForInjection(...args) {
  }

  onDidChangeHighlighting(callback) {
    return this.emitter.on('did-change-highlighting', callback)
  }

  tokenizedLineForRow(row) {
  }

  getScopeChain(...args) {
    console.log("getScopeChain", args)
  }

  bufferDidChange(change) {
    if(!this.tree) return;

    this.newRanges.push(change.newRange)
    const possibleDefinition = this.boundaries.lt(change.oldRange.end).value?.definition
    if(possibleDefinition) this.oldNodeTexts.add(possibleDefinition)

    const startIndex = this.buffer.characterIndexForPosition(change.newRange.start)
    this.tree.edit({
      startPosition: change.newRange.start,
      oldEndPosition: change.oldRange.end,
      newEndPosition: change.newRange.end,
      startIndex: startIndex,
      oldEndIndex: startIndex + change.oldText.length,
      newEndIndex: this.buffer.characterIndexForPosition(change.newRange.end)
    })
    const newTree = this.parser.parse(this.buffer.getText(), this.tree)
    // const changes = newTree.getChangedRanges(this.tree)
    this.tree = newTree
  }

  _updateBoundaries(from, to) {
    this._updateSyntax(from, to)

    if(this.localsQuery) {
      const locals = this.localsQuery.captures(this.tree.rootNode, from, to)
      this._updateWithLocals(locals)
      this._prepareInvalidations()
    }
  }

  _updateSyntax(from, to) {
    const syntax = this.syntaxQuery.captures(this.tree.rootNode, from, to)
    let oldDataIterator = this.boundaries.ge(from)
    let oldScopes = []

    while( oldDataIterator.hasNext && comparePoints(oldDataIterator.key, to) <= 0 ) {
      this.boundaries = this.boundaries.remove(oldDataIterator.key)
      oldScopes = oldDataIterator.value.closeScopeIds
      oldDataIterator.next()
    }

    oldScopes = oldScopes || []
    syntax.forEach(({node, name}) => {
      // const node = capture.node
      // const names = capture.name.split('.')

      // names.forEach(name => {
      let id = this.scopeNames.get(name)
      if(!id) {
        this.lastId += 2
        id = this.lastId
        const newId = this.lastId;
        this.scopeNames.set(name, newId)
        this.scopeIds.set(newId, name)
      }
      // })

      // const ds = names.map(name => this.scopeNames.get(name))
      let old = this.boundaries.get(node.startPosition)
      if(old) {
        old.openNode = node
        if(old.openScopeIds.length === 0) {
          old.openScopeIds = [id]
        }
      } else {
        this.boundaries = this.boundaries.insert(node.startPosition, {
          closeScopeIds: [...oldScopes],
          openScopeIds: [id],
          openNode: node,
          position: node.startPosition
        })
        oldScopes = [id]
      }

      old = this.boundaries.get(node.endPosition)
      if(old) {
        old.closeNode = node
        if(old.closeScopeIds.length === 0) old.closeScopeIds = [id]
      } else {
        this.boundaries = this.boundaries.insert(node.endPosition, {
          closeScopeIds: [id],
          openScopeIds: [],
          closeNode: node,
          position: node.endPosition
        })
      }
    })

    this.boundaries = this.boundaries.insert(Point.INFINITY, {
      closeScopeIds: [...oldScopes],
      openScopeIds: [],
      position: Point.INFINITY
    })
  }

  _prepareInvalidations() {
    let nodes = this.oldNodeTexts
    let parentScopes = createTree(comparePoints)

    this.newRanges.forEach(range => {
      const newNodeText = this.boundaries.lt(range.end).value?.definition
      if(newNodeText) nodes.add(newNodeText)
      const parent = findNodeInCurrentScope(
        this.boundaries, range.start, v => v.scope === 'open'
      )
      if(parent) parentScopes = parentScopes.insert(parent.position, parent)
    })

    parentScopes.forEach((_, val) => {
      const from = val.position, to = val.closeScopeNode.position
      const range = new Range(from, to)
      this._invalidateReferences(range, nodes)
    })
    this.oldNodeTexts = new Set()
    this.newRanges = []
  }

  _invalidateReferences(range, invalidatedNames) {
    const {start, end} = range
    let it = this.boundaries.ge(start)
    while(it.hasNext) {
      const node = it.value.openNode
      if(node && !it.value.definition) {
        const txt = node.text
        if(invalidatedNames.has(txt)) {
          const range = new Range(node.startPosition, node.endPosition)
          this.emitter.emit('did-change-highlighting', range)
        }
      }
      it.next()
      if(comparePoints(it.key, end) >= 0) return
    }
  }

  _updateWithLocals(locals) {
    const size = locals.length
    for(let i = 0; i < size; i++) {
      const {name, node} = locals[i]
      const nextOne = locals[i+1]

      const duplicatedLocalScope = nextOne &&
        comparePoints(node.startPosition, nextOne.node.startPosition) === 0 &&
        comparePoints(node.endPosition, nextOne.node.endPosition) === 0
      if(duplicatedLocalScope) {
        // Local reference have lower precedence over everything else
        if(name === 'local.reference') continue;
      }

      let openNode = this._getOrInsert(node.startPosition, node)
      if(!openNode.openNode) openNode.openNode = node
      let closeNode = this._getOrInsert(node.endPosition, node)
      if(!closeNode.closeNode) closeNode.closeNode = node

      if(name === "local.scope") {
        openNode.scope = "open"
        closeNode.scope = "close"
        openNode.closeScopeNode = closeNode
        closeNode.openScopeNode = openNode
        const parentNode = findNodeInCurrentScope(
          this.boundaries, node.startPosition, v => v.scope === 'open')
        const depth = parentNode?.depth || 0
        openNode.depth = depth + 1
        closeNode.depth = depth + 1
      } else if(name === "local.reference" && !openNode.definition) {
        const varName = node.text
        const varScope = findNodeInCurrentScope(
          this.boundaries, node.startPosition, v => v.definition === varName)
        if(varScope) {
          openNode.openScopeIds = varScope.openScopeIds
          closeNode.closeScopeIds = varScope.closeDefinition.closeScopeIds
        }
      } else if(name === "local.definition") {
        const shouldAddVarToScopes = openNode.openScopeIds.indexOf(VAR_ID) === -1
        if(shouldAddVarToScopes) {
          openNode.openScopeIds = [...openNode.openScopeIds, VAR_ID]
          closeNode.closeScopeIds = [VAR_ID, ...closeNode.closeScopeIds]
        }

        openNode.definition = node.text
        openNode.closeDefinition = closeNode
      }
    }
  }

  _getOrInsert(key) {
    const existing = this.boundaries.get(key)
    if(existing) {
      return existing
    } else {
      const obj = {openScopeIds: [], closeScopeIds: [], position: key}
      this.boundaries = this.boundaries.insert(key, obj)
      return obj
    }
  }

  bufferDidFinishTransaction(...args) {
    // console.log("bufferDidFinishTransaction", args)
  }

  buildHighlightIterator() {
    if(!this.parser) return nullIterator;
    let iterator// = boundaries.ge({row: 0, column: 0})
    const updateBoundaries = (start, end) => {
      this._updateBoundaries(start, end)
      return this.boundaries
    }

    return {
      getOpenScopeIds () {
        return [...new Set(iterator.value.openScopeIds)]
      },

      getCloseScopeIds () {
        return [...new Set(iterator.value.closeScopeIds)]
      },

      getPosition () {
        return (iterator.value && iterator.value.position) || Point.INFINITY
      },

      moveToSuccessor () {
        return iterator.next()
      },

      seek(start, endRow) {
        const end = {row: endRow + 1, column: 0}
        iterator = updateBoundaries(start, end).ge(start)
        return []
      }
    }
  }

  classNameForScopeId(scopeId) {
    const scope = this.scopeIds.get(scopeId)
    if(scope) return `syntax--${scope.replace(/\./g, ' syntax--')}`
  }

  scopeForId(scopeId) {
    return this.scopeIds[scopeId]
  }

  scopeDescriptorForPosition(position) {
    if(!this.tree) return new ScopeDescriptor({scopes: ['text']})
    const current = Point.fromObject(position)
    let begin = Point.fromObject(position)
    begin.column = 0
    const end = Point.fromObject([begin.row+1, 0])
    this._updateBoundaries(begin, end)
    const it = this.boundaries.ge(begin)
    if(!it.value) return new ScopeDescriptor({scopes: ['text']})

    let scopeIds = []
    while(comparePoints(it.key, current) <= 0) {
      const closing = new Set(it.value.closeScopeIds)
      scopeIds = scopeIds.filter(s => !closing.has(s))
      scopeIds.push(...it.value.openScopeIds)
      if(!it.hasNext) break
      it.next()
    }

    const scopes = scopeIds.map(id => this.classNameForScopeId(id).replace(/^syntax--/, '').replace(/\s?syntax--/g, '.'))
    return new ScopeDescriptor({scopes})
  }

  getFoldableRanges() {
    if(!this.tree) return [];
    console.log("Folds")
    return []
  }

  getFoldableRangesAtIndentLevel(level) {
    if(!this.tree) return [];
    console.log("FoldsIdent", level)
    return []
  }

  getFoldableRangeContainingPoint(point) {
    const foldsAtRow = this._getFoldsAtRow(point.row)
    console.log("FoldsPoint", foldsAtRow)
    const node = foldsAtRow[0]?.node
    if(node) return new Range(node.startPosition, node.endPosition)
  }

  isFoldableAtRow(row) {
    const foldsAtRow = this._getFoldsAtRow(row)
    return foldsAtRow.length !== 0
  }

  _getFoldsAtRow(row) {
    if(!this.tree) return []
    const folds = this.foldsQuery.captures(this.tree.rootNode,
      {row: row, column: 0}, {row: row+1, column: 0})
    return folds.filter(fold => fold.node.startPosition.row === row)
  }
}
module.exports = WASMTreeSitterLanguageMode;

const nullIterator = {
  seek: () => [],
  compare: () => 1,
  moveToSuccessor: () => {},
  getPosition: () => Point.INFINITY,
  getOpenScopeIds: () => [],
  getCloseScopeIds: () => []
}

function findNodeInCurrentScope(boundaries, position, filter) {
  let iterator = boundaries.ge(position)
  while(iterator.hasPrev) {
    iterator.prev()
    const value = iterator.value
    if(filter(value)) return value

    if(value.scope === 'close') {
      // If we have a closing scope, there's an "inner scope" that we will
      // ignore, and move the iterator BEFORE the inner scope position
      iterator = boundaries.lt(value.openScopeNode.position)
    } else if(value.scope === 'open') {
      // But, if we find an "open" scope, we check depth. If it's `1`, we
      // got into the last nested scope we were inside, so it's time to quit
      if(value.depth === 1) return
    }
  }
}

function comparePoints(a, b) {
  const rows = a.row - b.row
  if(rows === 0)
    return a.column - b.column
  else
    return rows
}
