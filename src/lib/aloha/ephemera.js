/* ephemera.js is part of Aloha Editor project http://aloha-editor.org
 *
 * Aloha Editor is a WYSIWYG HTML5 inline editing library and editor. 
 * Copyright (c) 2010-2012 Gentics Software GmbH, Vienna, Austria.
 * Contributors http://aloha-editor.org/contribution.php 
 * 
 * Aloha Editor is free software; you can redistribute it and/or
 * modify it under the terms of the GNU General Public License
 * as published by the Free Software Foundation; either version 2
 * of the License, or any later version.
 *
 * Aloha Editor is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program; if not, write to the Free Software
 * Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301, USA.
 * 
 * As an additional permission to the GNU GPL version 2, you may distribute
 * non-source (e.g., minimized or compacted) forms of the Aloha-Editor
 * source code without the copy of the GNU GPL normally required,
 * provided you include this license notice and a URL through which
 * recipients can access the Corresponding Source.
 */
/**
 * Provides functions to mark the contents of editables as ephemeral. An
 * editable's ephemeral content will be pruned before it is being
 * returned by editable.getContents().
 * 
 * It is planned to replace most instances of makeClean() with this
 * implementation for improved performance and more importantly, in
 * order to have a centralized place that has the control over all
 * ephemeral content, which can be leveraged by plugins to provide more
 * advanced functionality.
 *
 * Some examples that would be possible:
 * * a HTML source code text box, an interactive tree structure, or
 *   other kind of DOM visualization, next to the editable, that
 *   contains just the content of the editable (without ephemeral data)
 *   and which is updated efficiently in real time after each keystroke.
 *
 * * change detection algorithms that are able to intelligently ignore
 *   ephemeral data and which would not trigger unless non-ephemeral
 *   data is added to the editable.
 *
 * * When a plugin provides very general functionality over all nodes of
 *   the DOM, somtimes the plugin may not know what is and what isn't
 *   supposed to be real content. The functionality provided here makes
 *   it possible for the plugin to exaclty distinguish real content from
 *   ephemeral content.
 *
 * TODO: currently only simple transformations are suppored, like
 *       marking classes, attributes and elements as ephemeral and removing
 *       them during the pruning process.
 *       In the future, support for the block-plugin and custom pruning
 *       functions should be added. This may be done by letting implementations
 *       completely control the pruning of a DOM element through a
 *       function that takes the content+ephemeral-data and returns only
 *       content - similar to make clean, but for single elements to reduce
 *       overhead.
 */
define([
	'jquery',
	'aloha/core',
	'aloha/console',
	'util/strings',
	'util/trees',
	'util/arrays',
	'util/maps',
	'util/dom2',
	'util/functions',
	'util/misc',
	'PubSub'
], function (
	$,
	Aloha,
	console,
	Strings,
	Trees,
	Arrays,
	Maps,
	Dom,
	Functions,
	Misc,
	PubSub
) {
	'use strict';

	var ephemeraMap = {
		classMap: {
			'aloha-cleanme': true,
			'aloha-ui-wrapper': true,
			'aloha-ui-filler': true,
			'aloha-ui-attr': true
		},
		attrMap: {
			'hidefocus': true,
			'hideFocus': true,
			'tabindex': true,
			'tabIndex': true,
			'TABLE.contenteditable': true,
			'TABLE.contentEditable': true
		},
		attrRxs: [
			/^(?:nodeIndex|sizcache|sizset|jquery)[\w\d]*$/i
		],
		pruneFns: []
	};

	var commonClsSubstr = 'aloha-';

	if (Aloha.settings.ephemera) {
		ephemera(Aloha.settings.ephemera);
	}

	/**
	 * Checks whether the given classes contain the substring common to
	 * all ephemeral classes. If the check fails, an warning will be
	 * logged and the substring will be set to the empty string which
	 * voids the performance improvement the common substring would
	 * otherwise have gained.
	 */
	function checkCommonSubstr(clss) {
		for (var i = 0, len = clss.length; i < len; i++) {
			if (-1 === clss[i].indexOf(commonClsSubstr)){
				console.warn('Class "' + clss[i] + '" was set to be ephemeral,'
							 + 'which hurts peformance.'
							 + ' Add the common substring "' + commonClsSubstr
							 + '" to the class to fix this problem.');
				commonClsSubstr = '';
			}
		}
	}

	/**
	 * Registers ephemeral classes.
	 *
	 * An ephemeral class is a non-content class that will be pruned
	 * from the from the result of editable.getContents().
	 *
	 * The given classes should contain the string 'aloha-' to get the
	 * benefit of a performance optimization.
	 *
	 * Returns a map that contains all classes that were ever registered
	 * with this function.
	 *
	 * Multiple classes may be specified. If none are specified, just
	 * returns the current ephemeral classes map without modifying it.
	 *
	 * Also see ephemera().
	 */
	function classes() {
		var clss = Array.prototype.slice.call(arguments);
		Maps.fillKeys(ephemeraMap.classMap, clss, true);
		checkCommonSubstr(clss);
		PubSub.pub('aloha.ephemera.classes', {ephemera: ephemeraMap, newClasses: clss});
	}

	/**
	 * Registers ephemeral attributes by attribute name.
	 *
	 * Similar to classes() except applies to entire attributes instead
	 * of individual classes in the class attribute.
	 */
	function attributes() {
		var attrs = Array.prototype.slice.call(arguments);
		Maps.fillKeys(ephemeraMap.attrMap, attrs, true);
		PubSub.pub('aloha.ephemera.attributes', {ephemera: ephemeraMap, newAttributes: attrs});
	}
	
	/**
	 * Merges a map containing values to identify ephemeral content into
	 * a global registry.
	 *
	 * The given map may have the following entries
	 * classMap - a map from class name to the value true
	 * attrMap  - a map from attribute name to the value true; attribute
	 *            names may be optionally prefixed with "ELEMENT.",
	 *            where ELEMENT is the name of an element in uppercase,
	 *            to prune only from specific elements. An element name prefix
	 *            should always be specified if it is known, and if
	 *            multiple are known, multiple entries with separate
	 *            element prefixes should be made instead of a single
	 *            entry without - preserve information for refactoring.
	 * attrRxs  - an array of regexes in object form (/[a-z].../ and not "[a-z]...")
	 * pruneFns - an array of functions that will be called at each pruning step.
	 *
	 * Returns the global registry, which has the same structure as above.
	 *
	 * When a DOM tree is pruned with prune(elem) without an emap
	 * argument, the global registry maintained with classes()
	 * attributes() and ephemera() is used as a default map. If an emap
	 * argument is specified, the global registry will be ignored and
	 * the emap argument will be used instead.
	 *
	 * When a DOM tree is pruned with prune()
	 * * classes specified by classMap will be removed
	 * * attributes specified by attrMap or attrRxs will be removed
	 * * functions specified by pruneFns will be called as the DOM tree
     *   is descended into (pre-order), with each node (element, text,
     *   etc.) as a single argument. The function is free to modify the
     *   element and return it, or return a new element which will
     *   replace the given element in the pruned tree. If null or
     *   undefined is returned, the element will be removed from the
     *   tree. As per contract of Maps.walkDomInplace, it is allowed to
     *   insert/remove children in the parent node as long as the given
     *   node is not removed.
	 *
	 * Also see classes() and attributes().
	 *
	 * Note that removal of attributes doesn't always work on IE7 (in
	 * rare special cases). The dom-to-xhtml plugin can reliably remove
	 * ephemeral attributes during the serialization step.
	 */
	function ephemera(emap) {
		if (emap) {
			if (emap.classMap) {
				$.extend(ephemeraMap.classMap, emap.classMap);
			}
			if (emap.attrMap) {
				$.extend(ephemeraMap.attrMap , emap.attrMap);
			}
			if (emap.attrRxs) {
				ephemeraMap.attrRxs = ephemeraMap.attrRxs.concat(emap.attrRxs);
			}
			if (emap.pruneFns) {
				ephemeraMap.pruneFns = ephemeraMap.pruneFns.concat(emap.pruneFns);
			}
			PubSub.pub('aloha.ephemera', {ephemera: ephemeraMap, newEphemera: emap});
		}
		return ephemeraMap;
	}

	/**
	 * Marks an element as ephemeral.
	 *
	 * The element will be completely removed when the prune function is
	 * called on it.
	 */
	function markElement(elem) {
		$(elem).addClass('aloha-cleanme');
	}

	/**
	 * Marks the attribute of an element as ephemeral.
	 *
	 * The attribute will be removed from the element when the prune
	 * function is called on it.
	 *
	 * Multiple attributes can be passed at the same time be separating
	 * them with a space.
	 */
	function markAttribute(elem, attr) {
		elem = $(elem);
		var data = elem.attr('data-aloha-ui-attr');
		data = (null == data || '' === data ? attr : data + ' ' + attr);
		elem.attr('data-aloha-ui-attr', data);
		elem.addClass('aloha-ui-attr');
	}

	/**
	 * Marks an element as a ephemeral, excluding subnodes.
	 *
	 * The element will be removed when the prune function is called on
	 * it, but any children of the wrapper element will remain in its
	 * place.
	 *
	 * A wrapper is an element that wraps a single non-ephemeral
	 * element. A filler is an element that is wrapped by a single
	 * non-ephemeral element. This distinction is not important for the
	 * prune function, which behave the same for both wrappers and
	 * fillers, but it makes it easier to build more advanced content
	 * inspection algorithms (also see note at the header of ephemeral.js).
	 * 
	 * NB: a wrapper element must not wrap a filler element. Wrappers
	 *     and fillers are ephermeral. A wrapper must always wrap a
	 *     single _non-ephemeral_ element, and a filler must always fill
	 *     a single _non-ephemeral_ element.
	 */
	function markWrapper(elem) {
		$(elem).addClass('aloha-ui-wrapper');
	}

	/**
	 * Marks an element as ephemeral, excluding subnodes.
	 *
	 * See wrapper()
	 */
	function markFiller(elem) {
		$(elem).addClass('aloha-ui-filler');
	}

	/**
	 * Prunes attributes marked as ephemeral with Ephemera.attributes()
	 * from the given element.
	 */
	function pruneMarkedAttrs(elem) {
		var $elem = $(elem);
		var data = $elem.attr('data-aloha-ui-attr');
		$elem.removeAttr('data-aloha-ui-attr');
		if (typeof data === 'string') {
			var attrs = Strings.words(data);
			for (var i = 0; i < attrs.length; i++) {
				$elem.removeAttr(attrs[i]);
			}
		}
	}

	/**
	 * Determines whether the given attribute of the given element is
	 * ephemeral according to the given emap.
	 * See Ephemera.ephemera() for an explanation of attrMap and attrRxs.
	 */
	function isAttrEphemeral(elem, attrName, attrMap, attrRxs) {
		return attrMap[attrName]
			|| Misc.anyRx(attrRxs, attrName)
			|| attrMap[elem.nodeName + '.' + attrName];
	}

	/**
	 * Prunes attributes specified with either emap.attrMap or emap.attrRxs.
	 * See ephemera().
	 */
	function pruneEmapAttrs(elem, emap) {
		var $elem = null,
		    attrs = Dom.attrNames(elem),
		    name;
		for (var i = 0, len = attrs.length; i < len; i++) {
			name = attrs[i];
			if (isAttrEphemeral(elem, name, emap.attrMap, emap.attrRxs)) {
				$elem = $elem || $(elem);
				$elem.removeAttr(name);
			}
		}
	}

	/**
	 * Prunes an element of attributes and classes or removes the
	 * element by returning false.
	 *
	 * Elements attributes and classes can either be marked as
	 * ephemeral, in which case the element itself will contain the
	 * prune-info, or they can be specified as ephemeral with the given
	 * emap.
	 *
	 * See ephemera() for an explanation of the emap argument.
	 */
	function pruneElem(elem, emap) {
		var className = elem.className;
		if (className && -1 !== className.indexOf(commonClsSubstr)) {
			var classes = Strings.words(className);

			// Ephemera.markElement()
			if (-1 !== Arrays.indexOf(classes, 'aloha-cleanme')) {
				$.removeData(elem); // avoids memory leak
				return false; // removes the element
			}

			// Ephemera.markWrapper() and Ephemera.markFiller()
			if (-1 !== Arrays.indexOf(classes, 'aloha-ui-wrapper') ||
				-1 !== Arrays.indexOf(classes, 'aloha-ui-filler')) {
				Dom.moveNextAll(elem.parentNode, elem.firstChild, elem.nextSibling);
				$.removeData(elem);
				return false;
			}

			// Ephemera.markAttribute()
			if (-1 !== Arrays.indexOf(classes, 'aloha-ui-attr')) {
				pruneMarkedAttrs(elem);
			}

			// Ephemera.classes() and Ehpemera.ephemera({ classMap: {} })
			var persistentClasses = Arrays.filter(classes, function (cls) {
				return !emap.classMap[cls];
			});
			if (persistentClasses.length !== classes.length) {
				if (0 === persistentClasses.length) {
					// Removing the attributes is dangerous. Aloha has a
					// jquery patch in place to fix some issue.
					$(elem).removeAttr('class');
				} else {
					elem.className = persistentClasses.join(' ');
				}
			}
		}

		// Ephemera.attributes() and Ephemera.ephemera({ attrMap: {}, attrRxs: {} })
		pruneEmapAttrs(elem, emap);

		return true;
	}

	/**
	 * Called for each node during the pruning of a DOM tree.
	 */
	function pruneStep(emap, step, node) {
		if (1 === node.nodeType) {
			if (!pruneElem(node, emap)) {
				return [];
			}
			node = Trees.walkDomInplace(node, step);
		}

		// Ephemera.ephemera({ pruneFns: [] })
		node = Arrays.reduce(emap.pruneFns, node, Arrays.applyNotNull);
		if (!node) {
			return [];
		}

		return [node];
	}

	/**
	 * Prunes the given element of all ephemeral data.
	 *
	 * Elements marked with Ephemera.markElement() will be removed.
	 * Attributes marked with Ephemera.markAttribute() will be removed.
	 * Elements marked with Ephemera.markWrapper() or
	 * Ephemera.markFiller() will be replaced with their children.
	 *
	 * See ephemera() for an explanation of the emap argument.
	 *
	 * All properties of emap, if specified, are required, but may be
	 * empty.
	 *
	 * The element is modified in-place and returned.
	 */
	function prune(elem, emap) {
		emap = emap || ephemeraMap;
		function pruneStepClosure(node) {
			return pruneStep(emap, pruneStepClosure, node);
		}
		return pruneStepClosure(elem)[0];
	}

	return {
		ephemera: ephemera,
		classes: classes,
		attributes: attributes,
		markElement: markElement,
		markAttribute: markAttribute,
		markWrapper: markWrapper,
		markFiller: markFiller,
		prune: prune,
		isAttrEphemeral: isAttrEphemeral
	};
});
