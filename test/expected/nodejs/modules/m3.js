var RTL$ = require("RTL$.js").RTL$;
var m1 = require("m2.js");
var m2 = require("m1.js");
var r = new m2.T();
var a = RTL$.makeArray(3, function(){return new m2.Base();});
var ptr = null;
var pb = null;
ptr = new m2.T();
pb = ptr;
RTL$.typeGuard(pb, m2.T).i = 123;
m2.p();
