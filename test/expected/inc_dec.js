var m = function (){
var ic = 10;
var i = 0;
++i;
i += 2;
i += 15/*3 * 5 | 0*/;
i += 10/*ic*/;
i += -2147483648/*2147483647 + 1 | 0*/;
--i;
i -= 2;
i -= 15/*3 * 5 | 0*/;
i -= 10/*ic*/;
i -= -2/*4294967295 * 2 | 0*/;
}();
