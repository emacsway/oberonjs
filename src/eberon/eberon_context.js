"use strict";

var Cast = require("js/Cast.js");
var Class = require("rtl.js").Class;
var Code = require("js/Code.js");
var CodeGenerator = require("js/CodeGenerator.js");
var Context = require("context.js");
var EberonConstructor= require("js/EberonConstructor.js");
var EberonContext= require("js/EberonContext.js");
var EberonDynamicArray = require("js/EberonDynamicArray.js");
var EberonMap = require("js/EberonMap.js");
var EberonRecord = require("js/EberonRecord.js");
var EberonScope = require("js/EberonScope.js");
var EberonString = require("js/EberonString.js");
var EberonTypes = require("js/EberonTypes.js");
var Errors = require("js/Errors.js");
var op = require("js/Operator.js");
var eOp = require("js/EberonOperator.js");
var Symbol = require("js/Symbols.js");
var Procedure = require("js/Procedure.js");
var Type = require("js/Types.js");
var TypePromotion = require("eberon/eberon_type_promotion.js");

/*
function log(s){
    console.info(s);
}
*/

function superMethodCallGenerator(context, type){
    var args = Procedure.makeArgumentsCode(context);
    args.write(Code.makeExpression("this"));
    return Procedure.makeProcCallGeneratorWithCustomArgs(context, type, args);
}

function MethodOrProcMsg(id, type){
    this.id = id;
    this.type = type;
}

var ProcOrMethodId = Context.Chained.extend({
    init: function EberonContext$ProcOrMethodId(parent){
        Context.Chained.prototype.init.call(this, parent);
        this.__maybeTypeId = undefined;
        this.__type = undefined;
    },
    handleIdent: function(id){this.__maybeTypeId = id;},
    handleLiteral: function(s){
        var ss = Context.getSymbolAndScope(this, this.__maybeTypeId);
        var type = Context.unwrapType(ss.symbol().info());
        if (!(type instanceof Type.Record))
            throw new Errors.Error(
                  "RECORD type expected in method declaration, got '"
                + type.description() + "'");
        if (ss.scope() != this.currentScope())
            throw new Errors.Error(
                  "method should be defined in the same scope as its bound type '"
                + this.__maybeTypeId
                + "'");
        this.__type = type;
    },
    handleIdentdef: function(id){
        if (this.__type && id.exported())
            throw new Errors.Error("method implementation cannot be exported: " + id.id());
        checkOrdinaryExport(id, "procedure");
        this.handleMessage(new MethodOrProcMsg(id, this.__type));
    }
});

var MethodHeading = Context.Chained.extend({
    init: function EberonContext$MethodHeading(parent){
        Context.Chained.prototype.init.call(this, parent);
        this.__id = undefined;
        this.__type = undefined;
    },
    handleIdentdef: function(id){
        checkOrdinaryExport(id, "method");
        this.__id = id;
    },
    typeName: function(){return undefined;},
    setType: function(type){this.__type = type;},
    endParse: function(){
        this.handleMessage(new MethodOrProcMsg(this.__id, this.__type));
    }
});

function getMethodSelf(){}
function getSelfAsPointerMsg(){}
function getMethodSuper(){}

var ResultVariable = Class.extend.call(Type.Variable, {
    init: function(e){
        this.__e = e;
    },
    expression: function(){return this.__e;},
    type: function(){return this.__e.type();},
    isReadOnly: function(){return true;},
    idType: function(){return "procedure call " + (this.type() ? "result" : "statement");}
});

var TypeNarrowVariableBase = Class.extend.call(Type.Variable, {
    init: function TypeNarrowVariableBase(){
    }    
});

var TypeNarrowVariable = TypeNarrowVariableBase.extend({
    init: function TypeNarrowVariable(type, isRef, isReadOnly){
        this.__type = type;
        this.__isRef = isRef;
        this.__isReadOnly = isReadOnly;
    },
    type: function(){
        return this.__type;
    },
    isReference: function(){
        return this.__isRef;
    },
    isReadOnly: function(){
        return this.__isReadOnly;
    },
    idType: function(){
        return this.__isReadOnly ? "non-VAR formal parameter"
                                 : TypeNarrowVariableBase.prototype.idType.call(this);
    },
    setType: function(type){
        this.__type = type;
    }
});

var DereferencedTypeNarrowVariable = TypeNarrowVariableBase.extend({
    init: function DereferencedTypeNarrowVariable(v){
        this.__v = v;
    },
    type: function(){
        return this.__v.type();
    },
    isReference: function(){
        return true;
    },
    isReadOnly: function(){
        return false;
    },
    setType: function(type){
        this.__v.setType(type);
    }
});

var InPlaceStringLiteral = TypeNarrowVariable.extend({
    init: function(type){
        TypeNarrowVariable.prototype.init.call(this, type, false, true);
    },
    idType: function(){return "string literal";}
});

var Identdef = Context.Identdef.extend({
    init: function(parent){
        Context.Identdef.prototype.init.call(this, parent);
        this.__ro = false;
    },
    handleLiteral: function(l){
        if (l == "-")
            this.__ro = true;  
        Context.Identdef.prototype.handleLiteral.call(this, l);
    },
    _makeIdendef: function(){
        return new EberonContext.IdentdefInfo(this._id, this._export, this.__ro);
    }
});

function makeContextCall(context, call){
    var l = context.language();
    var cx = {
        types: l.types, 
        rtl: l.rtl, 
        qualifyScope: context.qualifyScope.bind(context)
        };
    return call(cx);
    }

function OperatorNewMsg(e){
    this.expression = e;
}

var Designator = Context.Designator.extend({
    init: function EberonContext$Designator(parent){
        Context.Designator.prototype.init.call(this, parent);
        this.__procCall = undefined;
    },
    _indexSequence: function(type, info){
        if (type == EberonString.string()){
            var indexType = Type.basic().ch;
            return { length: undefined, 
                     type: indexType,
                     info: EberonString.makeElementVariable(indexType)
                   };
        }
        return Context.Designator.prototype._indexSequence.call(this, type, info);
    },
    _makeDerefVar: function(info){
        if (info instanceof TypeNarrowVariable)
            return new DereferencedTypeNarrowVariable(info);
        return Context.Designator.prototype._makeDerefVar(info);
    },
    handleMessage: function(msg){
        if (msg == Context.beginCallMsg)
            return this.__beginCall();
        if (msg == Context.endCallMsg)
            return this.__endCall();
        if (msg instanceof OperatorNewMsg){
            var e = msg.expression;
            this._advance(e.type(), new ResultVariable(e), e.code());
            return;
        }

        // no type promotion after calling functions
        if (breakTypePromotion(msg))
            return;
        
        return Context.Designator.prototype.handleMessage.call(this, msg);
    },
    handleExpression: function(e){
        if (this.__procCall)
            this.__procCall.handleArgument(e);
        else
            Context.Designator.prototype.handleExpression.call(this, e);
    },
    handleLiteral: function(s){
        if (s == "SELF"){
            var type = this.handleMessage(getMethodSelf);
            this._advance(type, type, "this");
        } 
        else if (s == "POINTER"){
            var typeId = new Type.TypeId(this.handleMessage(getSelfAsPointerMsg));
            var pointerType = new Type.Pointer("", typeId);
            var info = Type.makeVariable(pointerType, true);
            this._advance(pointerType, info, "");
        }
        else if (s == "SUPER"){
            var ms = this.handleMessage(getMethodSuper);
            this._advance(ms.info.type, ms.info, ms.code);
        }
        else 
            Context.Designator.prototype.handleLiteral.call(this, s);
    },
    __beginCall: function(){
        var type = this._currentType();
        if (type instanceof Type.TypeId && type.type() instanceof Type.Record){
            this.__procCall = makeContextCall(
                this, 
                function(cx){ return EberonConstructor.makeConstructorCall(type, cx, false); }
                );
            this._discardCode();
        }
        else
            this.__procCall = Context.makeProcCall(this, type, this._currentInfo());
    },
    __endCall: function(){
        var e = this.__procCall.end();
        this._advance(e.type(), new ResultVariable(e), e.code());
        this.__procCall = undefined;
    }
});

var OperatorNew = Context.Chained.extend({
    init: function EberonContext$OperatorNew(parent){
        Context.Chained.prototype.init.call(this, parent);
        this.__info = undefined;
        this.__call = undefined;
    },
    handleQIdent: function(q){
        var found = Context.getQIdSymbolAndScope(this, q);
        var s = found.symbol();
        var info = s.info();

        if (!(info instanceof Type.TypeId))
            throw new Errors.Error("record type is expected in operator NEW, got '" + info.idType() + "'");

        var type = info.type();
        if (!(type instanceof Type.Record))
            throw new Errors.Error("record type is expected in operator NEW, got '" + type.description() + "'");
        
        this.__info = info;        
    },
    handleExpression: function(e){
        this.__call.handleArgument(e);
    },
    handleMessage: function(msg){
        if (msg == Context.beginCallMsg){
            this.__call = makeContextCall(
                this,
                function(cx){ return EberonConstructor.makeConstructorCall(this.__info, cx, true); }.bind(this)
                );
            return;
        }
        if (msg == Context.endCallMsg)
            return;

        return Context.Chained.prototype.handleMessage.call(this, msg);
    },
    endParse: function(){
        this.handleMessage(new OperatorNewMsg(this.__call.end()));
    }
});

var InPlaceVariableInit = Context.Chained.extend({
    init: function EberonContext$InPlaceVariableInit(context){
        Context.Chained.prototype.init.call(this, context);
        this.__id = undefined;
        this._symbol = undefined;
        this._code = undefined;
    },
    codeGenerator: function(){return CodeGenerator.nullGenerator();},
    handleIdent: function(id){
        this.__id = id;
    },
    handleLiteral: function(){
        this._code = "var " + this.__id + " = ";
    },
    handleExpression: function(e){
        var type = e.type();
        var isString = Type.isString(type);
        if (!isString && !(type instanceof Type.StorageType))
            throw new Errors.Error("cannot use " + type.description() + " to initialize variable");
        var v = isString ? new InPlaceStringLiteral(type) 
                         : new TypeNarrowVariable(type, false, false);
        this._symbol = new Symbol.Symbol(this.__id, v);
        if (type instanceof Type.Record){
            EberonRecord.ensureCanBeInstantiated(this, type, EberonRecord.instantiateForCopy);
            if (e.designator())
                this._code += this.language().rtl.cloneRecord(e.code());
            else // do not clone if it is temporary, e.g. constructor call
                this._code += e.code();
        }
        else if (type instanceof Type.Array){
            if (type instanceof Type.OpenArray)
                throw new Errors.Error("cannot initialize variable '" + this.__id + "' with open array");
            this._code += Cast.cloneArray(type, e.code(), this.language().rtl);
        }
        else
            this._code += Code.derefExpression(e).code();
    },
    _onParsed: function(){
        this.parent().codeGenerator().write(this._code);
    },
    endParse: function(){
        if (!this._symbol)
            return false;

        this.currentScope().addSymbol(this._symbol);
        this._onParsed();
        return true;
    }
});

var InPlaceVariableInitFor = InPlaceVariableInit.extend({
    init: function EberonContext$InPlaceVariableInitFor(context){
        InPlaceVariableInit.prototype.init.call(this, context);
    },
    _onParsed: function(){
        this.parent().handleInPlaceInit(this._symbol, this._code);
    }
});

var ExpressionProcedureCall = Context.Chained.extend({
    init: function EberonContext$init(context){
        Context.Chained.prototype.init.call(this, context);
    },
    setDesignator: function(d){
        var info = d.info();
        var parent = this.parent();
        if (info instanceof ResultVariable){
            var e = info.expression();
            parent.handleExpression(new Code.Expression(d.code(), d.type(), undefined, e.constValue(), e.maxPrecedence()));
        }
        else
            parent.setDesignator(d);
    }
});

var AssignmentOrProcedureCall = Context.Chained.extend({
    init: function EberonContext$init(context){
        Context.Chained.prototype.init.call(this, context);
        this.__left = undefined;
        this.__right = undefined;
    },
    setDesignator: function(d){
        this.__left = d;
    },
    handleExpression: function(e){
        this.__right = e;
    },
    codeGenerator: function(){return CodeGenerator.nullGenerator();},
    endParse: function(){
        var d = this.__left;
        var type = d.type();
        var code;
        if (this.__right){
        /*    if (type instanceof EberonDynamicArray.DynamicArray){
                if (!(this.__right.type() instanceof Type.Array))
                    throw new Errors.Error("type mismatch");
                code = d.code() + " = " + this.language().rtl.clone(this.__right.code());
            }
            else */{
                var left = Code.makeExpression(d.code(), type, d);
                code = op.assign(left, this.__right, this.language());
            } 
        }
        else if (!(d.info() instanceof ResultVariable)){
            var procCall = Context.makeProcCall(this, type, d.info());
            var result = procCall.end();
            Context.assertProcStatementResult(result.type());
            code = d.code() + result.code();
        }
        else{
            Context.assertProcStatementResult(type);
            code = d.code();
        }
    
    this.parent().codeGenerator().write(code);
    }
});

function checkOrdinaryExport(id, hint){
    if (id.isReadOnly())
        throw new Errors.Error(hint + " cannot be exported as read-only using '-' mark (did you mean '*'?)");
}

var ConstDecl = Context.ConstDecl.extend({
    init: function EberonContext$ConstDecl(context){
        Context.ConstDecl.prototype.init.call(this, context);
    },
    handleIdentdef: function(id){
        checkOrdinaryExport(id, "constant");
        Context.ConstDecl.prototype.handleIdentdef.call(this, id);
    }
});

var VariableDeclaration = Context.VariableDeclaration.extend({
    init: function EberonContext$VariableDeclaration(context){
        Context.VariableDeclaration.prototype.init.call(this, context);
    },
    handleIdentdef: function(id){
        checkOrdinaryExport(id, "variable");
        Context.VariableDeclaration.prototype.handleIdentdef.call(this, id);
    },
    _initCode: function(){
        var type = this.type();
        if (type instanceof EberonRecord.Record)
            EberonRecord.ensureCanBeInstantiated(this, type, EberonRecord.instantiateForVar);
        return Context.VariableDeclaration.prototype._initCode.call(this);
    }
});

var TypeDeclaration = Context.TypeDeclaration.extend({
    init: function EberonContext$TypeDeclaration(context){
        Context.TypeDeclaration.prototype.init.call(this, context);
    },
    handleIdentdef: function(id){
        checkOrdinaryExport(id, "type");
        Context.TypeDeclaration.prototype.handleIdentdef.call(this, id);
    }
});

var RecordDecl = Context.RecordDecl.extend({
    init: function EberonContext$RecordDecl(context){
        Context.RecordDecl.prototype.init.call(this, context, EberonRecord.Record);
    },
    handleMessage: function(msg){
        if (msg instanceof MethodOrProcMsg){
            var methodType = msg.type;
            var boundType = this.type();
            var id = msg.id.id();
            if (Type.typeName(boundType) == id){
                if (msg.id.exported()){
                    var typeId = this.parent().id();
                    if (!typeId.exported())
                        throw new Errors.Error("constructor '" + id + "' cannot be exported because record itslef is not exported");
                }
                boundType.declareConstructor(methodType, msg.id.exported());
            }
            else
                boundType.addMethod(msg.id,
                                    new EberonTypes.MethodType(id, methodType, Procedure.makeProcCallGenerator));
            return;
        }

        if (msg == Context.endParametersMsg) // not used
            return undefined;
        if (msg instanceof Context.AddArgumentMsg) // not used
            return undefined;
        return Context.RecordDecl.prototype.handleMessage.call(this, msg);
    },
    _makeField: function(field, type){
        return new EberonRecord.RecordField(field, type, this.__type);
    },
    _generateBaseConstructorCallCode: function(){
        var base = Type.recordBase(this.type());
        if (!base)
            return "";
        var baseConstructor = EberonRecord.constructor$(base);
        if (!baseConstructor || !baseConstructor.args().length)
            return Context.RecordDecl.prototype._generateBaseConstructorCallCode.call(this);
        
        return this._qualifiedBaseConstructor() + ".apply(this, arguments);\n";
    },
    endParse: function(){
        var type = this.type();
        if (!type.customConstructor)
            return Context.RecordDecl.prototype.endParse.call(this);

        this.codeGenerator().write(this._generateInheritance());
        type.setRecordInitializationCode(
            this._generateBaseConstructorCallCode());
    }
});

function breakTypePromotion(msg){
    if (msg instanceof TransferPromotedTypesMsg){
        msg.promotion.clear();
        return true;
    }
    if (msg instanceof PromoteTypeMsg)
        return true;
}

function handleTypePromotionMadeInSeparateStatement(msg){
    if (breakTypePromotion(msg))
        return true;
    if (msg instanceof BeginTypePromotionOrMsg){
        msg.result = new TypePromotion.OrPromotions();
        return true;
    }
    return false;
}

function getConstructorSuperMsg(){}
function getConstructorBoundType(){}

function InitFieldMsg(id){
    this.id = id;
}

var BaseInit = Context.Chained.extend({
    init: function EberonContext$BaseInit(parent){
        Context.Chained.prototype.init.call(this, parent);
        this.__type = undefined;
        this.__initCall = undefined;
        this.__initField = undefined;
    },
    type: function(){
        if (!this.__type)
            this.__type = this.handleMessage(getConstructorBoundType);
        return this.__type;
    },
    codeGenerator: function(){return CodeGenerator.nullGenerator();},
    handleMessage: function(msg){
        if (msg == Context.beginCallMsg)
            return;
        if (msg == Context.endCallMsg){
            var e = this.__initCall.end();
            if (this.__initField)
                this.type().setFieldInitializationCode(this.__initField, e.code());
            else
                this.type().setBaseConstructorCallCode(e.code());
            return;
        }
        return Context.Chained.prototype.handleMessage.call(this, msg);
    },
    handleIdent: function(id){
        this.__initField = id;
        this.__initCall = this.handleMessage(new InitFieldMsg(id));
    },
    handleExpression: function(e){
        this.__initCall.handleArgument(e);
    },
    handleLiteral: function(s){
        if (s == "SUPER"){
            var ms = this.handleMessage(getConstructorSuperMsg);
            this.__initCall = makeContextCall(
                this,
                function(cx){ 
                    return EberonConstructor.makeBaseConstructorCall(
                        Type.recordBase(this.type()), 
                        cx);
                    }.bind(this)
                );
        }
    }
});

var ProcOrMethodDecl = Context.ProcDecl.extend({
    init: function EberonContext$ProcOrMethodDecl(parent, stdSymbols){
        Context.ProcDecl.prototype.init.call(this, parent, stdSymbols);
        this.__methodId = undefined;
        this.__methodType = undefined;
        this.__boundType = undefined;
        this.__endingId = undefined;
        this.__isConstructor = false;
        this.__baseConstructorWasCalled = false;
        this.__initedFields = [];
    },
    handleMessage: function(msg){
        if (msg == getMethodSelf){
            if (!this.__boundType)
                throw new Errors.Error("SELF can be used only in methods");
            return this.__boundType;
        }
        if (msg == getSelfAsPointerMsg){
            this.__boundType.requireNewOnly();
            return this.__boundType;
        }

        if (msg == getConstructorBoundType)
            return this.__boundType;

        if (msg == getConstructorSuperMsg){
            this.__baseConstructorWasCalled = true;
            return this.__handleSuperCall();
        }

        if (msg == getMethodSuper){
            if (this.__isConstructor)
                throw new Errors.Error("cannot call base constructor from procedure body (use '| SUPER' to pass parameters to base constructor)");
            return this.__handleSuperCall();
        }

        if (msg instanceof InitFieldMsg)
            return this.__handleFieldInit(msg.id);

        if (msg instanceof MethodOrProcMsg){
            var id = msg.id;
            var type = msg.type;
            if (type){
                this.__methodId = id;
                this.__boundType = type;
                var name = Type.typeName(type);
                this.__isConstructor = name == id.id();
            }

            Context.ProcDecl.prototype.handleIdentdef.call(this, id);
            return;
        }

        if (handleTypePromotionMadeInSeparateStatement(msg))
            return;

        return Context.ProcDecl.prototype.handleMessage.call(this, msg);
    },
    _prolog: function(){
        return this.__boundType
            ? this.__isConstructor ? "function " + Type.typeName(this.__boundType) + "("
                                   : Type.typeName(this.__boundType) + ".prototype." + this.__methodId.id() + " = function("
            : Context.ProcDecl.prototype._prolog.call(this);
    },
    _beginBody: function(){
        Context.ProcDecl.prototype._beginBody.call(this);
        if (this.__isConstructor)
            this.codeGenerator().write(
                this.__boundType.baseConstructorCallCode
              + EberonRecord.fieldsInitializationCode(this.__boundType, this));
    },
    _makeArgumentVariable: function(arg){
        if (!arg.isVar)
            return new TypeNarrowVariable(arg.type, false, true);

        if (arg.type instanceof Type.Record)
            return new TypeNarrowVariable(arg.type, true, false);

        return Context.ProcDecl.prototype._makeArgumentVariable.call(this, arg);
    },
    setType: function(type){
        if (this.__methodId){
            this.__methodType = new EberonTypes.MethodType(this.__methodId.id(), type, Procedure.makeProcCallGenerator);
            this.__type = type;
            }            
        else
            Context.ProcDecl.prototype.setType.call(this, type);
    },
    handleIdent: function(id){
        if (!this.__boundType)
            Context.ProcDecl.prototype.handleIdent.call(this, id);
        else if (this.__endingId)
            this.__endingId = this.__endingId + "." + id;
        else
            this.__endingId = id;
    },
    endParse: function(){
        Context.ProcDecl.prototype.endParse.call(this);

        if (this.__boundType){
            if (this.__endingId){
                var expected = Type.typeName(this.__boundType) + "." + this.__id.id();
                if (this.__endingId != expected)
                    throw new Errors.Error(
                          "mismatched method names: expected '" 
                        + expected
                        + "' at the end (or nothing), got '" 
                        + this.__endingId + "'");
            }

            if (this.__isConstructor){
                this.__boundType.defineConstructor(this.__methodType.procType());

                var base = Type.recordBase(this.__boundType);
                var baseConstructor = base && EberonRecord.constructor$(base);
                if (!this.__baseConstructorWasCalled && baseConstructor && baseConstructor.args().length)
                    throw new Errors.Error("base record constructor has parameters but was not called (use '| SUPER' to pass parameters to base constructor)");
                if (this.__baseConstructorWasCalled && (!baseConstructor || !baseConstructor.args().length))
                    throw new Errors.Error("base record constructor has no parameters and will be called automatically (do not use '| SUPER' to call base constructor)");
            }
            else
                this.__boundType.defineMethod(this.__methodId, this.__methodType);
        }
    },
    __handleSuperCall: function(){
        if (!this.__methodId)
            throw new Errors.Error("SUPER can be used only in methods");

        var baseType = Type.recordBase(this.__boundType);
        if (!baseType)
            throw new Errors.Error(
                  "'" + Type.typeName(this.__boundType)
                + "' has no base type - SUPER cannot be used");

        var id = this.__methodId.id();
        if (!this.__isConstructor)
            EberonRecord.requireMethodDefinition(baseType, id, "cannot use abstract method(s) in SUPER calls");
        
        return {
            info: this.__isConstructor ? undefined
                                       : new Type.ProcedureId(new EberonTypes.MethodType(id, this.__methodType.procType(), superMethodCallGenerator)),
            code: this.qualifyScope(Type.recordScope(baseType))
                + Type.typeName(baseType) + ".prototype." + id + ".call"
        };
    },
    __handleFieldInit: function(id){
        var fields = Type.recordOwnFields(this.__boundType);
        if (!fields.hasOwnProperty(id))
            throw new Errors.Error("'" + id + "' is not record '" + Type.typeName(this.__boundType) + "' own field");
        
        if (this.__initedFields.indexOf(id) != -1)
            throw new Errors.Error("field '" + id + "' is already initialized");

        this.__initedFields.push(id);        
        var type = fields[id].type();
        return makeContextCall(
            this, 
            function(cx){return EberonConstructor.makeFieldInitCall(type, cx, id);});
    }
});

var Factor = Context.Factor;

var AddOperator = Context.AddOperator.extend({
    init: function EberonContext$AddOperator(context){
        Context.AddOperator.prototype.init.call(this, context);
    },
    _matchPlusOperator: function(type){
        if (type == EberonString.string() || type instanceof Type.String)
            return eOp.addStr;
        return Context.AddOperator.prototype._matchPlusOperator.call(this, type);
    },
    _expectPlusOperator: function(){return "numeric type or SET or STRING";},
    endParse: function(){
        this.parent().handleLogicalOr();
    }
});

var MulOperator = Context.MulOperator.extend({
    init: function EberonContext$MulOperator(context){
        Context.MulOperator.prototype.init.call(this, context);
    },
    endParse: function(s){
        this.parent().handleLogicalAnd();
    }
});

function PromoteTypeMsg(info, type){
    this.info = info;
    this.type = type;
}

function TransferPromotedTypesMsg(promotion){
    this.promotion = promotion;
}

var RelationOps = Context.RelationOps.extend({
    init: function EberonContext$RelationOps(){
        Context.RelationOps.prototype.init.call(this);
    },
    eq: function(type){
        return type == EberonString.string() 
            ? eOp.equalStr
            : Context.RelationOps.prototype.eq.call(this, type);
    },
    notEq: function(type){
        return type == EberonString.string() 
            ? eOp.notEqualStr
            : Context.RelationOps.prototype.notEq.call(this, type);
    },
    less: function(type){
        return type == EberonString.string() 
            ? eOp.lessStr
            : Context.RelationOps.prototype.less.call(this, type);
    },
    greater: function(type){
        return type == EberonString.string() 
            ? eOp.greaterStr
            : Context.RelationOps.prototype.greater.call(this, type);
    },
    lessEq: function(type){
        return type == EberonString.string() 
            ? eOp.lessEqualStr
            : Context.RelationOps.prototype.lessEq.call(this, type);
    },
    greaterEq: function(type){
        return type == EberonString.string() 
            ? eOp.greaterEqualStr
            : Context.RelationOps.prototype.greaterEq.call(this, type);
    },
    is: function(type, context){
        var impl = Context.RelationOps.prototype.is.call(this, type, context);
        return function(left, right){
            var d = left.designator();
            if (d){
                var v = d.info();
                if (v instanceof TypeNarrowVariableBase)
                    context.handleMessage(new PromoteTypeMsg(v, type));
            }
            return impl(left, right);
        };
    },
    coalesceType: function(leftType, rightType){
        if ((leftType == EberonString.string() && rightType instanceof Type.String)
            || (rightType == EberonString.string() && leftType instanceof Type.String))
            return EberonString.string();
        return Context.RelationOps.prototype.coalesceType.call(this, leftType, rightType);
    }
});

function BeginTypePromotionAndMsg(){
    this.result = undefined;
}

function BeginTypePromotionOrMsg(){
    this.result = undefined;
}

var Term = Context.Term.extend({
    init: function EberonContext$Term(context){
        Context.Term.prototype.init.call(this, context);
        this.__typePromotion = undefined;
        this.__currentPromotion = undefined;
        this.__andHandled = false;
    },
    handleMessage: function(msg){
        if (msg instanceof PromoteTypeMsg) {
            var promoted = msg.info;
            var p = this.__getCurrentPromotion();
            if (p)
                p.promote(promoted, msg.type);
            return;
        }
        if (msg instanceof BeginTypePromotionOrMsg){
            var cp = this.__getCurrentPromotion();
            if (cp)
                msg.result = cp.makeOr();
            return;
        }
        return Context.Term.prototype.handleMessage.call(this, msg);
    },
    handleLogicalAnd: function(){
        if (this.__typePromotion)
            this.__currentPromotion = this.__typePromotion.next();
        else
            this.__andHandled = true;
    },
    handleLogicalNot: function(){
        Context.Term.prototype.handleLogicalNot.call(this);
        var p = this.__getCurrentPromotion();
        if (p)
            p.invert();
    },
    __getCurrentPromotion: function(){
        if (!this.__currentPromotion){
            var msg = new BeginTypePromotionAndMsg();
            this.parent().handleMessage(msg);
            this.__typePromotion = msg.result;
            if (this.__typePromotion){
                if (this.__andHandled)
                    this.__typePromotion.next();
                this.__currentPromotion = this.__typePromotion.next();
            }
        }
        return this.__currentPromotion;
    }
});

var SimpleExpression = Context.SimpleExpression.extend({
    init: function EberonContext$SimpleExpression(context){
        Context.SimpleExpression.prototype.init.call(this, context);
        this.__typePromotion = undefined;
        this.__currentTypePromotion = undefined;
        this.__orHandled = false;
    },
    handleLogicalOr: function(){
        if (this.__typePromotion)
            this.__currentPromotion = this.__typePromotion.next();
        else
            this.__orHandled = true;
    },
    handleMessage: function(msg){
        if (msg instanceof BeginTypePromotionAndMsg){
            var p = this.__getCurrentPromotion();
            if (p)
                msg.result = p.makeAnd();
            return;
        }
        return Context.SimpleExpression.prototype.handleMessage.call(this, msg);
    },
    endParse: function(){
        if (this.__typePromotion)
            this.parent().handleTypePromotion(this.__typePromotion);
        Context.SimpleExpression.prototype.endParse.call(this);
    },
    __getCurrentPromotion: function(){
        if (!this.__currentPromotion){
            var msg = new BeginTypePromotionOrMsg();
            this.parent().handleMessage(msg);
            this.__typePromotion = msg.result;
            if (this.__typePromotion){
                if (this.__orHandled)
                    this.__typePromotion.next();
                this.__currentPromotion = this.__typePromotion.next();
            }
        }
        return this.__currentPromotion;
    }
});

var relationOps = new RelationOps();

var Expression = Context.Expression.extend({
    init: function EberonContext$Expression(context){
        Context.Expression.prototype.init.call(this, context, relationOps);
        this.__typePromotion = undefined;
        this.__currentTypePromotion = undefined;
    },
    handleMessage: function(msg){
        if (msg instanceof TransferPromotedTypesMsg)
            return;
        return Context.Expression.prototype.handleMessage.call(this, msg);
    },
    handleTypePromotion: function(t){
        this.__currentTypePromotion = t;
    },
    handleLiteral: function(s){
        if (this.__currentTypePromotion){
            this.__currentTypePromotion.clear();
        }
        Context.Expression.prototype.handleLiteral.call(this, s);
    },
    endParse: function(){
        if (this.__currentTypePromotion)
            this.parent().handleMessage(new TransferPromotedTypesMsg(this.__currentTypePromotion));
        return Context.Expression.prototype.endParse.call(this);
    }
});

var OperatorScopes = Class.extend({
    init: function EberonContext$OperatorScopes(context){
        this.__context = context;
        this.__scope = undefined;

        this.__typePromotion = undefined;
        this.__typePromotions = [];
        this.__ignorePromotions = false;
        this.alternate();
    },
    handleMessage: function(msg){
        if (this.__ignorePromotions)
            return false;
        if (msg instanceof TransferPromotedTypesMsg)
            return true;
        if (msg instanceof PromoteTypeMsg){
            this.__typePromotion = new TypePromotion.Promotion(msg.info, msg.type);
            this.__typePromotions.push(this.__typePromotion);
            return true;
        }
        if (msg instanceof BeginTypePromotionOrMsg){
            this.__typePromotion = new TypePromotion.OrPromotions();
            this.__typePromotions.push(this.__typePromotion);
            msg.result = this.__typePromotion;
            return true;
        }
        return false;
    },
    doThen: function(){
        if (this.__typePromotion)
            this.__typePromotion.and();
        this.__ignorePromotions = true;
    },
    alternate: function(){
        if (this.__scope)
            this.__context.popScope();
        this.__scope = EberonScope.makeOperator(
            this.__context.currentScope(),
            this.__context.language().stdSymbols);
        this.__context.pushScope(this.__scope);

        if (this.__typePromotion){
            this.__typePromotion.reset();
            this.__typePromotion.or();
            this.__typePromotion = undefined;
        }
        this.__ignorePromotions = false;
    },
    reset: function(){
        this.__context.popScope();
        for(var i = 0; i < this.__typePromotions.length; ++i){
            this.__typePromotions[i].reset();
        }
    }
});

var While = Context.While.extend({
    init: function EberonContext$While(context){
        Context.While.prototype.init.call(this, context);
        this.__scopes = new OperatorScopes(this);
    },
    handleLiteral: function(s){
        Context.While.prototype.handleLiteral.call(this, s);
        if (s == "DO")
            this.__scopes.doThen();
        else if (s == "ELSIF")
            this.__scopes.alternate();
    },
    handleMessage: function(msg){
        if (this.__scopes.handleMessage(msg))
            return;

        return Context.While.prototype.handleMessage.call(this, msg);
    },
    endParse: function(){
        this.__scopes.reset();
        Context.While.prototype.endParse.call(this);
    }
});

var If = Context.If.extend({
    init: function EberonContext$If(context){
        Context.If.prototype.init.call(this, context);
        this.__scopes = new OperatorScopes(this);
    },
    handleMessage: function(msg){
        if (this.__scopes.handleMessage(msg))
            return;

        return Context.If.prototype.handleMessage.call(this, msg);
    },
    handleLiteral: function(s){
        Context.If.prototype.handleLiteral.call(this, s);
        if (s == "THEN")
            this.__scopes.doThen();
        else if (s == "ELSIF" || s == "ELSE")
            this.__scopes.alternate();
    },
    endParse: function(){
        this.__scopes.reset();
        Context.If.prototype.endParse.call(this);
    }
});

var CaseLabel = Context.CaseLabel.extend({
    init: function EberonContext$CaseLabel(context){
        Context.CaseLabel.prototype.init.call(this, context);
    },
    handleLiteral: function(s){
        if (s == ':'){ // statement sequence is expected now
            var scope = EberonScope.makeOperator(
                this.parent().currentScope(),
                this.language().stdSymbols);
            this.pushScope(scope);
        }
    },
    endParse: function(){
        this.popScope();
        Context.CaseLabel.prototype.endParse.call(this);
    }
});

var Repeat = Context.Repeat.extend({
    init: function EberonContext$Repeat(context){
        Context.Repeat.prototype.init.call(this, context);
        var scope = EberonScope.makeOperator(
            this.parent().currentScope(),
            this.language().stdSymbols);
        this.pushScope(scope);
    },
    endParse: function(){
        this.popScope();
        //Context.Repeat.prototype.endParse.call(this);
    }
});

var Return = Context.Return.extend({
    init: function EberonContext$Return(context){
        Context.Return.prototype.init.call(this, context);
    },
    handleExpression: function(e){
        var type = e.type();
        if (type instanceof Type.Array)
            e = Code.makeSimpleExpression(Cast.cloneArray(type, e.code(), this.language().rtl), type);
        Context.Return.prototype.handleExpression.call(this, e);
    }
});

var For = Context.For.extend({
    init: function EberonContext$Repeat(context){
        Context.For.prototype.init.call(this, context);
        var scope = EberonScope.makeOperator(
            this.parent().currentScope(),
            this.language().stdSymbols);
        this.pushScope(scope);
    },
    handleInPlaceInit: function(symbol, code){
        this._handleInitCode(symbol.id(), "for (" + code);
        this._handleInitExpression(symbol.info().type());
    },
    endParse: function(){
        this.popScope();
        Context.For.prototype.endParse.call(this);
    }
});

var dynamicArrayLength = -1;

var ArrayDimensions = Context.ArrayDimensions.extend({
    init: function EberonContext$ArrayDimensions(context){
        Context.ArrayDimensions.prototype.init.call(this, context);
    },
    handleLiteral: function(s){
        if ( s == "*" )
            this._addDimension(dynamicArrayLength);
        else
            Context.ArrayDimensions.prototype.handleLiteral.call(this, s);
    }
});

var MapDecl = Context.Chained.extend({
    init: function EberonContext$MapDecl(context){
        Context.Chained.prototype.init.call(this, context);
        this.__type = undefined;
    },
    handleQIdent: function(q){
        var s = Context.getQIdSymbolAndScope(this, q);
        var type = Context.unwrapType(s.symbol().info());
        this.setType(type);
    },
    // anonymous types can be used in map declaration
    setType: function(type){
        this.__type = type;
    },
    isAnonymousDeclaration: function(){return true;},
    typeName: function(){return undefined;},
    endParse: function(){
        this.parent().setType(new EberonMap.Type(this.__type));
    }
});

var ArrayDecl = Context.ArrayDecl.extend({
    init: function EberonContext$ArrayDecl(context){
        Context.ArrayDecl.prototype.init.call(this, context);
    },
    _makeInit: function(type, dimensions, length){
        if (length == dynamicArrayLength)
            return '[]';

        if (type instanceof EberonRecord.Record && EberonRecord.hasParameterizedConstructor(type))
            throw new Errors.Error("cannot use '" + Type.typeName(type) + "' as an element of static array because it has constructor with parameters");

        return Context.ArrayDecl.prototype._makeInit.call(this, type, dimensions, length);
    },
    _makeType: function(elementsType, init, length){
        return length == dynamicArrayLength
            ? new EberonDynamicArray.DynamicArray(elementsType)
            : Context.ArrayDecl.prototype._makeType.call(this, elementsType, init, length);
    }
});

function assertArgumentIsNotNonVarDynamicArray(msg){
    if (msg instanceof Context.AddArgumentMsg){
        var arg = msg.arg;
        if (!arg.isVar){
            var type = arg.type;
            while (type instanceof Type.Array){
                if (type instanceof EberonDynamicArray.DynamicArray)
                    throw new Errors.Error("dynamic array has no use as non-VAR argument '" + msg.name + "'");
                type = Type.arrayElementsType(type);
            }
        }
    }
}

var FormalParameters = Context.FormalParameters.extend({
    init: function EberonContext$FormalParameters(context){
        Context.FormalParameters.prototype.init.call(this, context);
    },
    handleMessage: function(msg){
        assertArgumentIsNotNonVarDynamicArray(msg);
        return Context.FormalParameters.prototype.handleMessage.call(this, msg);
    },
    _checkResultType: function(type){
        if (type instanceof EberonDynamicArray.DynamicArray)
            return;
        Context.FormalParameters.prototype._checkResultType.call(this, type);
    }
});

var FormalType = Context.HandleSymbolAsType.extend({
    init: function EberonContext$FormalType(context){
        Context.HandleSymbolAsType.prototype.init.call(this, context);
        this.__arrayDimensions = [];
        this.__dynamicDimension = false;
    },
    setType: function(type){           
        for(var i = this.__arrayDimensions.length; i--;){
            var Cons = this.__arrayDimensions[i]
                ? EberonDynamicArray.DynamicArray
                : this.language().types.OpenArray;
            type = new Cons(type);
        }
        this.parent().setType(type);
    },
    handleLiteral: function(s){
        if (s == "*")
            this.__dynamicDimension = true;
        else if ( s == "OF"){
            this.__arrayDimensions.push(this.__dynamicDimension);
            this.__dynamicDimension = false;
        }
    }
});

var FormalParametersProcDecl = Context.FormalParametersProcDecl.extend({
    init: function EberonContext$FormalParametersProcDecl(context){
        Context.FormalParametersProcDecl.prototype.init.call(this, context);
    },
    handleMessage: function(msg){
        assertArgumentIsNotNonVarDynamicArray(msg);
        return Context.FormalParametersProcDecl.prototype.handleMessage.call(this, msg);
    },
    _checkResultType: function(type){
        if (type instanceof EberonDynamicArray.DynamicArray)
            return;
        Context.FormalParametersProcDecl.prototype._checkResultType.call(this, type);
    }
});

var ModuleDeclaration = Context.ModuleDeclaration.extend({
    init: function EberonContext$ModuleDeclaration(context){
        Context.ModuleDeclaration.prototype.init.call(this, context);
    },
    handleMessage: function(msg){
        if (handleTypePromotionMadeInSeparateStatement(msg))
            return;
        return Context.ModuleDeclaration.prototype.handleMessage.call(this, msg);
    }
});

exports.AddOperator = AddOperator;
exports.ArrayDecl = ArrayDecl;
exports.ArrayDimensions = ArrayDimensions;
exports.BaseInit = BaseInit;
exports.CaseLabel = CaseLabel;
exports.ConstDecl = ConstDecl;
exports.Designator = Designator;
exports.Expression = Expression;
exports.ExpressionProcedureCall = ExpressionProcedureCall;
exports.For = For;
exports.FormalParameters = FormalParameters;
exports.FormalParametersProcDecl = FormalParametersProcDecl;
exports.FormalType = FormalType;
exports.Identdef = Identdef;
exports.If = If;
exports.MethodHeading = MethodHeading;
exports.ModuleDeclaration = ModuleDeclaration;
exports.MulOperator = MulOperator;
exports.AssignmentOrProcedureCall = AssignmentOrProcedureCall;
exports.Factor = Factor;
exports.MapDecl = MapDecl;
exports.ProcOrMethodId = ProcOrMethodId;
exports.ProcOrMethodDecl = ProcOrMethodDecl;
exports.RecordDecl = RecordDecl;
exports.Repeat = Repeat;
exports.Return = Return;
exports.SimpleExpression = SimpleExpression;
exports.InPlaceVariableInit = InPlaceVariableInit;
exports.InPlaceVariableInitFor = InPlaceVariableInitFor;
exports.OperatorNew = OperatorNew;
exports.Term = Term;
exports.TypeDeclaration = TypeDeclaration;
exports.VariableDeclaration = VariableDeclaration;
exports.While = While;
