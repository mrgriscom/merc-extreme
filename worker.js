


self.addEventListener('message', function(e) {
        self.postMessage(process_buffer(e.data));
    }, false);

function process_buffer(buff) {
    zooms = {};
    for (var i = 0; i < buff.length; i += 4) {
        var z = buff[i];
        zooms[z] = true;
    }
    return zooms;
}