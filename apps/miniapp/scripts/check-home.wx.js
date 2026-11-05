// Read-only regression probe: paste into WeChat DevTools Console on the home page.
// Run after loading has completed. No database, storage or application state is modified.
wx.createSelectorQuery()
  .selectAll('.mode-entry')
  .fields(
    { size: true, computedStyle: ['color', 'margin-left', 'margin-right'] },
    function (items) {
      var widths = items.map(function (item) {
        return item.width
      })
      var equalWidths =
        items.length === 5 && Math.max.apply(null, widths) - Math.min.apply(null, widths) < 1
      var matchesV4Text = items.every(function (item) {
        return item.color === 'rgb(244, 245, 241)'
      })
      console.log(
        '[V4-CHECK]',
        JSON.stringify({
          pass: equalWidths && matchesV4Text,
          equalWidths: equalWidths,
          matchesV4Text: matchesV4Text,
          items: items,
        }),
      )
    },
  )
  .exec()
