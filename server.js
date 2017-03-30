
const restify = require('restify');
const host = process.env.HOST || '127.0.0.1';
const port = process.env.PORT || '8080';
const debug = require('debug')('ethstats:server');

let ethstats = new (require('./lib/ethstatus'))();
//ethstats.startWeb3Connection;
 
const server = restify.createServer({
  name: 'Things API Server'
});
 
server.use(restify.queryParser());
server.use(restify.bodyParser()); // don't need this.
 
server.use(function logger(req,res,next) {
  debug(new Date(),req.method,req.url);
  //// TODO: check for valid API key ????
  next();
});
 
server.on('uncaughtException',function(request, response, route, error){
  console.error(error.stack);
  response.send(error);
});
 
server.listen(port,host, function() {
  console.log('%s listening at %s', server.name, server.url);
});

server.get('/status',function(req,res){
  res.json({"foobar":true });
});
 
server.get('/status/:name',function(req,res,next){
  // var id = req.params.id;
  // var thing = db.getThingById(id);
  // if(!thing){
  //   next(new restify.errors.ResourceNotFoundError());
  // }else{
  //   res.json(thing);
  // }
});



