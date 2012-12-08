


self.addEventListener('message', function(e) {
        self.postMessage(process_buffer(e.data));
    }, false);

function process_buffer(buff) {
    tiles = {};
    for (var i = 0; i < buff.length; i += 4) {
        var z = buff[i];
        var dx = buff[i + 1];
        var dy = buff[i + 2];
        tiles[z + ':' + dx + ':' + dy] = true;
    }
    return tiles;
}