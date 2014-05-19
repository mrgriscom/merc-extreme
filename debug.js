

function init_debug() {
    
    setComputedConstants();

    var context = new DebugContext();

    window.addEventListener("message", function(e) {
        context.update(e.data);
    }, false);
}

function DebugContext() {

    this.tovCanvas = $('#tileovl')[0];
    $(this.tovCanvas).attr('width', (TILE_OFFSET_RESOLUTION * (1 + MAX_ZOOM)) + 'px');
    $(this.tovCanvas).attr('height', (TILE_OFFSET_RESOLUTION * 2) + 'px');
    this.tovCtx = this.tovCanvas.getContext('2d');

    this.stats = new Stats();
    //this.stats.domElement.style.position = 'absolute';
    //this.stats.domElement.style.top = '0px';
    $('body').prepend(this.stats.domElement);

    this.$text = $('#text');

    this.update = function(data) {
        this[{
            frame: 'onframe',
            tiles: 'tile_ix_overview',
            text: 'textvals',
        }[data.type]](data.data);
    }

    this.onframe = function() {
        this.stats.update();
    }

    this.textvals = function(data) {
        var fields = [];
        _.each(data, function(v, k) {
            fields.push(k + ': ' + v);
        });
        this.$text.html(fields.join('<br>'));
    }

    this.tile_ix_overview = function(data) {
        var canvas = this.tovCanvas;
        var ctx = this.tovCtx;

        //console.log('worker result', data, _.size(data));
        ctx.fillStyle = '#444';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        var TO = TILE_OFFSET_RESOLUTION;
        for (var i = 0; i < 1 + MAX_ZOOM; i++) {
            for (var j = 0; j < 2; j++) {
            ctx.fillStyle = ((i + j) % 2 == 0 ? '#200' : '#002');
                ctx.fillRect(TO * i, TO * j, Math.min(Math.pow(2, i), TO), Math.min(Math.pow(2, i), TO));
                
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillStyle = '#555';
                ctx.font = '12pt sans-serif';
                ctx.fillText(i, TO * (i + .5), TO * (j + .5));
            }
        }
        
        $.each(data, function(k, v) {
            var pcs = k.split(':');
            var anti = +pcs[0];
            var z = +pcs[1];
            var dx = pcs[2] % TO;
            var dy = pcs[3] % TO;
            
            ctx.fillStyle = 'white';
            ctx.fillRect(TO * z + dx, TO * ((anti ? 1 : 0)) + dy, 1, 1);
        });
    }
}
