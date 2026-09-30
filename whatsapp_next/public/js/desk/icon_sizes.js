// Seven symbols of Frappe's Espresso sprite (`es-line-reload` among them) carry a fixed `width` /
// `height` beside their `viewBox`. `<use>` then draws them at that size instead of fitting them to
// the icon box, so at `icon-xs` (12 px) the reload arrows were cut off on every button of the app.
// Without the two attributes a symbol scales to whatever box shows it, as the other 268 already
// do. Only the page's copy of the sprite is touched, once it is in the document.

(function () {
	function fit() {
		const sized = document.querySelectorAll('symbol[id^="es-"][width], symbol[id^="es-"][height]');
		sized.forEach((symbol) => {
			symbol.removeAttribute("width");
			symbol.removeAttribute("height");
		});
		return document.querySelector('symbol[id^="es-"]') != null;
	}

	$(() => {
		// the sprite is injected with the page; if it is not there yet, try again a little later
		if (!fit()) window.setTimeout(fit, 1500);
	});
})();
